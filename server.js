// =========================================================================
// SERVEUR WEBHOOK VAPI -> TWILIO (remplace le workflow n8n)
// Recoit les evenements Vapi sur POST /webhook, ne traite que l'evenement
// "end-of-call-report", et envoie un SMS recapitulatif a l'artisan via Twilio.
// =========================================================================

require('dotenv').config();
const express = require('express');
const axios = require('axios');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_SENDER_ID,
  ARTISAN_PHONE_NUMBER,
  COMPANY_NAME,
  PORT,
} = process.env;

for (const [name, value] of Object.entries({ TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SENDER_ID, ARTISAN_PHONE_NUMBER })) {
  if (!value) {
    console.warn(`ATTENTION: la variable d'environnement ${name} n'est pas definie (voir .env). Les envois de SMS echoueront tant qu'elle est vide.`);
  }
}

const app = express();
// Limite relevee car un rapport de fin d'appel Vapi peut contenir un transcript long.
app.use(express.json({ limit: '5mb' }));

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

// Retourne la premiere valeur non vide (apres trim) parmi celles fournies, sinon
// undefined. Vapi peut placer une meme donnee a des emplacements differents du
// payload selon la version/le type d'evenement - on essaie chaque candidat dans
// l'ordre plutot que de supposer un seul chemin fixe.
function premierNonVide(...valeurs) {
  for (const valeur of valeurs) {
    if (typeof valeur === 'string' && valeur.trim() !== '') {
      return valeur.trim();
    }
  }
  return undefined;
}

// Extrait les champs utiles depuis le payload Vapi 'end-of-call-report'.
// Forme attendue : { message: { type, call, customer, analysis: { summary, structuredData }, ... } }
// mais 'call' contient aussi potentiellement son propre 'customer'/'analysis' imbrique
// (Call Object complet) - on tente les deux emplacements pour le telephone et le resume.
function extraireDonneesAppel(message) {
  const call = message.call || {};
  const structured =
    (message.analysis && message.analysis.structuredData) ||
    (call.analysis && call.analysis.structuredData) ||
    {};

  // Le numero de l'appelant vient normalement des metadonnees de l'appel (fiable).
  // Le champ structure 'telephone_client' (extrait par le LLM) est garde en dernier
  // recours seulement : on a constate qu'il peut contenir un texte de substitution
  // (ex: "numero de l'appelant") au lieu d'un vrai numero quand le modele ne l'a
  // pas determine lui-meme pendant la conversation.
  const telephoneClient =
    premierNonVide(
      message.customer && message.customer.number,
      call.customer && call.customer.number,
      structured.telephone_client
    ) || 'Non precise';

  // Le resume peut se trouver a plusieurs emplacements selon la forme exacte du
  // webhook recu : on essaie chaque emplacement plausible dans l'ordre.
  const resume =
    premierNonVide(
      message.analysis && message.analysis.summary,
      call.analysis && call.analysis.summary,
      message.summary,
      call.summary
    ) || 'Non disponible';

  return {
    nomClient: structured.nom_client || 'Client',
    telephoneClient,
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
// 5) type de logement, 6) eau coupee ou non, 7) nature du probleme, 8) resume libre
// (uniquement si un resume reel a ete trouve - ligne omise sinon).
function construireMessageArtisan(donnees) {
  const urgenceLabel = donnees.urgence === 'urgent' ? 'URGENT 🔴' : 'NON URGENT 🟢';

  const lignes = [
    urgenceLabel,
    `Client : ${donnees.nomClient}`,
    `Telephone : ${donnees.telephoneClient}`,
    `Adresse : ${donnees.adresse}`,
    `Logement : ${donnees.typeLogement}`,
    `Eau coupee : ${donnees.eauCoupee}`,
    `Probleme : ${donnees.probleme}`,
  ];

  const resume = (donnees.resume || '').trim();
  if (resume !== '' && resume !== 'Non disponible') {
    lignes.push(`Resume : ${resume}`);
  }

  return lignes.join('\n');
}

async function envoyerSmsArtisan(texte) {
  // Utilise un Alphanumeric Sender ID Twilio (ex: "PlombTest") plutot qu'un numero de
  // telephone comme expediteur - evite les erreurs de correspondance pays/numero
  // rencontrees avec un numero Twilio classique. Limites Twilio : 11 caracteres max,
  // lettres/chiffres uniquement, sans espace, et pas de reponse possible (one-way SMS).
  // Non supporte pour envoyer vers les Etats-Unis/Canada, mais OK pour la France.
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

  return axios.post(
    url,
    new URLSearchParams({
      To: ARTISAN_PHONE_NUMBER,
      From: TWILIO_SENDER_ID,
      Body: texte,
    }),
    {
      auth: {
        username: TWILIO_ACCOUNT_SID,
        password: TWILIO_AUTH_TOKEN,
      },
    }
  );
}

app.post('/webhook', async (req, res) => {
  // Aucune verification d'authenticite sur cette route : tout POST /webhook est accepte,
  // qu'il vienne reellement de Vapi ou non (voir avertissement securite communique a part).
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
    console.error('Erreur lors du traitement du webhook / envoi SMS Twilio :', detail);
    return res.status(500).json({ status: 'error', message: 'Echec du traitement du webhook, voir logs serveur' });
  }
});

// Verification rapide que le serveur tourne (pratique pour les checks de deploiement).
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', entreprise: COMPANY_NAME || null });
});

const port = PORT || 3000;
app.listen(port, () => {
  console.log(`Serveur webhook Vapi -> Twilio demarre sur le port ${port} (POST /webhook)`);
});
