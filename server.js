// =========================================================================
// SERVEUR WEBHOOK VAPI -> BREVO (remplace le workflow n8n)
// Recoit les evenements Vapi sur POST /webhook, ne traite que l'evenement
// "end-of-call-report", et envoie un SMS recapitulatif a l'artisan via Brevo.
// =========================================================================

require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const axios = require('axios');

const {
  BREVO_API_KEY,
  BREVO_SENDER_NAME,
  ARTISAN_PHONE_NUMBER,
  COMPANY_NAME,
  VAPI_WEBHOOK_SECRET,
  PORT,
} = process.env;

for (const [name, value] of Object.entries({ BREVO_API_KEY, BREVO_SENDER_NAME, ARTISAN_PHONE_NUMBER, VAPI_WEBHOOK_SECRET })) {
  if (!value) {
    console.warn(`ATTENTION: la variable d'environnement ${name} n'est pas definie (voir .env). ${name === 'VAPI_WEBHOOK_SECRET' ? 'Le webhook rejettera TOUTES les requetes tant que cette variable est vide.' : 'Les envois de SMS echoueront tant qu\'elle est vide.'}`);
  }
}

// Compare le secret recu au secret attendu en temps constant, pour eviter les
// attaques par mesure de timing sur une comparaison naive (===).
function secretValide(secretRecu) {
  if (!VAPI_WEBHOOK_SECRET || !secretRecu) return false;

  const attendu = Buffer.from(VAPI_WEBHOOK_SECRET);
  const recu = Buffer.from(String(secretRecu));

  // timingSafeEqual exige des buffers de meme longueur, sinon il leve une exception.
  if (attendu.length !== recu.length) return false;

  return crypto.timingSafeEqual(attendu, recu);
}

const app = express();
// Limite relevee car un rapport de fin d'appel Vapi peut contenir un transcript long.
app.use(express.json({ limit: '5mb' }));

// Numero de telephone au format international SANS le '+' : Brevo l'exige ainsi.
function normalizePhone(phone) {
  return (phone || '').replace(/[^0-9]/g, '');
}

// "appartement" -> "Appartement", chaine vide -> "Non precise"
function formatTypeLogement(typeLogement) {
  if (!typeLogement) return 'Non precise';
  return typeLogement.charAt(0).toUpperCase() + typeLogement.slice(1);
}

// enum Vapi 'oui' / 'non' / 'non_applicable' -> libelle lisible pour le SMS
function formatEauCoupee(eauCoupee) {
  const value = (eauCoupee || 'non_applicable').toLowerCase();
  if (value === 'oui') return 'Oui';
  if (value === 'non') return 'Non';
  return 'Non applicable';
}

// Extrait les champs utiles depuis le payload Vapi 'end-of-call-report'.
// Forme attendue : { message: { type, call, customer, analysis: { summary, structuredData }, ... } }
function extraireDonneesAppel(message) {
  const structured = (message.analysis && message.analysis.structuredData) || {};
  const resume = (message.analysis && message.analysis.summary) || message.summary || 'Non disponible';

  return {
    nomClient: structured.nom_client || 'Client',
    telephoneClient: structured.telephone_client || (message.customer && message.customer.number) || 'Non precise',
    adresse: structured.adresse_intervention || 'Non precisee',
    typeLogement: formatTypeLogement(structured.type_logement),
    probleme: structured.type_probleme || 'Demande de plomberie non precisee',
    urgence: (structured.niveau_urgence || 'non_urgent').toLowerCase(),
    eauCoupee: formatEauCoupee(structured.eau_coupee),
    resume,
  };
}

// Construit le SMS envoye a l'artisan. Ordre impose :
// 1) urgence en majuscules, 2) nom client, 3) telephone, 4) adresse,
// 5) type de logement, 6) eau coupee ou non, 7) nature du probleme, 8) resume libre.
function construireMessageArtisan(donnees) {
  const urgenceLabel = donnees.urgence === 'urgent' ? 'URGENT 🔴' : 'NON URGENT 🟢';

  return [
    urgenceLabel,
    `Client : ${donnees.nomClient}`,
    `Telephone : ${donnees.telephoneClient}`,
    `Adresse : ${donnees.adresse}`,
    `Logement : ${donnees.typeLogement}`,
    `Eau coupee : ${donnees.eauCoupee}`,
    `Probleme : ${donnees.probleme}`,
    `Resume : ${donnees.resume}`,
  ].join('\n');
}

async function envoyerSmsArtisan(texte) {
  return axios.post(
    'https://api.brevo.com/v3/transactionalSMS/sms',
    {
      sender: BREVO_SENDER_NAME,
      recipient: normalizePhone(ARTISAN_PHONE_NUMBER),
      content: texte,
      type: 'transactional',
    },
    {
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
    }
  );
}

app.post('/webhook', async (req, res) => {
  // === VERIFICATION DU SECRET WEBHOOK ===
  // Vapi envoie le secret configure (serverUrlSecret) dans l'en-tete 'x-vapi-secret'.
  // Express normalise les noms d'en-tetes en minuscules dans req.headers, donc pas
  // besoin de gerer plusieurs variantes de casse ici (contrairement au code n8n).
  const secretRecu = req.headers['x-vapi-secret'];
  if (!secretValide(secretRecu)) {
    console.warn('Requete webhook rejetee : secret invalide ou absent.');
    return res.status(401).json({ status: 'error', message: 'Secret webhook invalide' });
  }

  const message = req.body && req.body.message;

  // On ne traite que l'evenement de fin d'appel. Les autres evenements Vapi
  // (assistant-request, speech-update, transcript, status-update, ...) sont
  // acquittes sans action, sans erreur.
  if (!message || message.type !== 'end-of-call-report') {
    return res.status(200).json({ status: 'ignored', reason: 'evenement non traite (pas end-of-call-report)' });
  }

  try {
    const donnees = extraireDonneesAppel(message);
    const texteSms = construireMessageArtisan(donnees);

    await envoyerSmsArtisan(texteSms);

    console.log(`SMS artisan envoye (${donnees.urgence}) pour ${donnees.nomClient}.`);
    return res.status(200).json({ status: 'ok', smsArtisanEnvoye: true });
  } catch (err) {
    const detail = err.response ? err.response.data : err.message;
    console.error('Erreur lors du traitement du webhook / envoi SMS Brevo :', detail);
    return res.status(500).json({ status: 'error', message: 'Echec du traitement du webhook, voir logs serveur' });
  }
});

// Verification rapide que le serveur tourne (pratique pour les checks de deploiement).
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', entreprise: COMPANY_NAME || null });
});

const port = PORT || 3000;
app.listen(port, () => {
  console.log(`Serveur webhook Vapi -> Brevo demarre sur le port ${port} (POST /webhook)`);
});
