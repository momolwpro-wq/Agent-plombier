// =========================================================================
// SERVEUR WEBHOOK VAPI -> TWILIO (remplace le workflow n8n)
// Recoit les evenements Vapi sur POST /webhook, ne traite que l'evenement
// "end-of-call-report", et envoie via Twilio : un SMS recapitulatif a
// l'artisan, et un SMS de confirmation au client appelant.
// =========================================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');

// TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN restent globaux : un seul compte Twilio
// partage par tous les clients (voir dossier-mise-en-place-client.md, section 3/7).
// COMPANY_NAME, ARTISAN_PHONE_NUMBER, TWILIO_SENDER_ID ne sont plus lus depuis
// l'environnement : ce sont desormais des donnees PAR CLIENT, chargees depuis
// clients.json (voir chargerClients() ci-dessous).
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PORT } = process.env;

for (const [name, value] of Object.entries({ TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN })) {
  if (!value) {
    console.warn(`ATTENTION: la variable d'environnement ${name} n'est pas definie (voir .env). Les envois de SMS echoueront tant qu'elle est vide.`);
  }
}

// === REGISTRE CLIENT (multi-tenant) ===
// Charge clients.json une fois au demarrage et indexe les clients par assistantId
// pour un lookup rapide a chaque webhook. Si le fichier est absent/invalide, on
// demarre quand meme avec un registre vide plutot que de planter tout le serveur -
// les webhooks retomberont simplement dans le cas "aucun client trouve".
function chargerClients() {
  const cheminFichier = path.join(__dirname, 'clients.json');
  try {
    const contenu = fs.readFileSync(cheminFichier, 'utf8');
    const data = JSON.parse(contenu);
    const liste = Array.isArray(data.clients) ? data.clients : [];
    const index = new Map(liste.map((client) => [client.assistantId, client]));
    console.log(`Registre client charge : ${index.size} client(s) depuis clients.json.`);
    return index;
  } catch (err) {
    console.warn(`ATTENTION: impossible de charger clients.json (${err.message}). Demarrage avec un registre client vide.`);
    return new Map();
  }
}

const clientsParAssistantId = chargerClients();

// === STOCKAGE DES APPELS ===
// Journal simple (fichier JSON, tableau d'objets) de tous les appels traites, utilise
// par le recap hebdomadaire. Ecriture synchrone lecture-modification-ecriture : suffisant
// vu le faible volume attendu (pas de verrouillage/concurrence geree, non necessaire a
// cette echelle - voir dossier-mise-en-place-client.md pour les seuils de scaling).
const CHEMIN_DONNEES = path.join(__dirname, 'data');
const CHEMIN_APPELS = path.join(CHEMIN_DONNEES, 'appels.json');
fs.mkdirSync(CHEMIN_DONNEES, { recursive: true });

function chargerAppels() {
  try {
    if (!fs.existsSync(CHEMIN_APPELS)) return [];
    const data = JSON.parse(fs.readFileSync(CHEMIN_APPELS, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn(`ATTENTION: impossible de lire ${CHEMIN_APPELS} (${err.message}).`);
    return [];
  }
}

function enregistrerAppel(enregistrement) {
  const appels = chargerAppels();
  appels.push(enregistrement);
  fs.writeFileSync(CHEMIN_APPELS, JSON.stringify(appels, null, 2) + '\n');
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

// Extrait l'assistantId Vapi du payload, pour retrouver le client correspondant dans
// le registre. On essaie les emplacements plausibles dans l'ordre : message.assistant.id,
// message.call.assistantId, puis message.assistantId.
function extraireAssistantId(message) {
  return premierNonVide(
    message.assistant && message.assistant.id,
    message.call && message.call.assistantId,
    message.assistantId
  );
}

// Duree de l'appel en secondes, calculee a partir de call.startedAt/call.endedAt (Vapi
// ne fournit pas de champ duree pre-calcule - voir doc Call Object). Renvoie null si
// l'un des deux timestamps est absent/invalide ("si disponible" dans le payload).
function extraireDureeSecondes(message, call) {
  const debut = premierNonVide(call.startedAt, message.startedAt);
  const fin = premierNonVide(call.endedAt, message.endedAt);
  if (!debut || !fin) return null;
  const debutMs = Date.parse(debut);
  const finMs = Date.parse(fin);
  if (Number.isNaN(debutMs) || Number.isNaN(finMs)) return null;
  return Math.max(0, Math.round((finMs - debutMs) / 1000));
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

  // Numero reel de l'appelant, pour envoyer le SMS de confirmation CLIENT.
  // Volontairement SANS le fallback sur structured.telephone_client (extrait par le
  // LLM, pas garanti fiable) : si ce numero brut est absent, on ne devine pas un
  // numero de substitution pour un SMS envoye directement au client.
  const numeroAppelant = premierNonVide(
    message.customer && message.customer.number,
    call.customer && call.customer.number
  );

  // Le resume peut se trouver a plusieurs emplacements selon la forme exacte du
  // webhook recu : on essaie chaque emplacement plausible dans l'ordre.
  const resume =
    premierNonVide(
      message.analysis && message.analysis.summary,
      call.analysis && call.analysis.summary,
      message.summary,
      call.summary
    ) || 'Non disponible';

  // Date/heure de l'appel : fin d'appel (call.endedAt) si disponible, sinon l'instant
  // ou ce webhook est traite par notre serveur.
  const dateAppel = premierNonVide(call.endedAt, message.endedAt) || new Date().toISOString();
  const dureeSecondes = extraireDureeSecondes(message, call);

  return {
    nomClient: structured.nom_client || 'Client',
    telephoneClient,
    numeroAppelant,
    adresse: structured.adresse_intervention || 'Non precisee',
    codePostal: structured.code_postal || 'Non precise',
    typeLogement: formatTypeLogement(structured.type_logement),
    probleme: structured.type_probleme || 'Demande de plomberie non precisee',
    urgence: (structured.niveau_urgence || 'non_urgent').toLowerCase(),
    eauCoupee: formatEauCoupee(structured.eau_coupee),
    resume,
    dateAppel,
    dureeSecondes,
  };
}

// Construit le SMS envoye a l'artisan. Ordre impose :
// 1) urgence en majuscules, 2) nom client, 3) telephone, 4) adresse, 5) code postal,
// 6) type de logement, 7) eau coupee ou non, 8) nature du probleme, 9) resume libre
// (uniquement si un resume reel a ete trouve - ligne omise sinon).
function construireMessageArtisan(donnees) {
  const urgenceLabel = donnees.urgence === 'urgent' ? 'URGENT 🔴' : 'NON URGENT 🟢';

  const lignes = [
    urgenceLabel,
    `Client : ${donnees.nomClient}`,
    `Telephone : ${donnees.telephoneClient}`,
    `Adresse : ${donnees.adresse}`,
    `Code postal : ${donnees.codePostal}`,
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

// Construit le SMS de confirmation envoye directement au CLIENT (numero appelant).
// Ne prend que le premier "prenom" de nomClient (le schema structure demande "nom et
// prenom", mais ce message n'utilise que le prenom) ; si nomClient vaut le fallback
// generique 'Client', le message reste correct ("Bonjour Client, ...").
function construireMessageClient(donnees, entreprise) {
  const prenom = (donnees.nomClient || 'Client').trim().split(/\s+/)[0];
  return `Bonjour ${prenom}, votre demande a bien été prise en compte par ${entreprise}. Un plombier vous recontactera dès que possible. Merci de votre confiance.`;
}

// Envoie un SMS via l'API REST Twilio. 'expediteur' est desormais fourni par client
// (client.twilioFromNumber depuis clients.json) plutot que fixe pour tout le monde -
// voir la note en tete de fichier sur le compte Twilio partage / expediteur par client.
async function envoyerSms(destinataire, expediteur, texte) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

  return axios.post(
    url,
    new URLSearchParams({
      To: destinataire,
      From: expediteur,
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

  // Identifie a quel client (registre clients.json) cet appel appartient.
  const assistantId = extraireAssistantId(message);
  const client = assistantId ? clientsParAssistantId.get(assistantId) : undefined;

  if (!client) {
    console.error(`Aucun client trouvé pour assistantId: ${assistantId}`);
    return res.status(200).json({ status: 'ignored', reason: 'client inconnu', assistantId: assistantId || null });
  }

  try {
    const donnees = extraireDonneesAppel(message);

    // Stockage de l'appel (journal pour le recap hebdomadaire). Une erreur ici est
    // loguee mais ne bloque jamais l'envoi des SMS ci-dessous.
    try {
      enregistrerAppel({
        date: donnees.dateAppel,
        assistantId,
        nomClient: donnees.nomClient,
        urgence: donnees.urgence === 'urgent' ? 'URGENT' : 'NON URGENT',
        dureeSecondes: donnees.dureeSecondes,
        adresse: donnees.adresse,
      });
    } catch (err) {
      console.warn(`ATTENTION: echec de l'enregistrement de l'appel dans ${CHEMIN_APPELS} : ${err.message}`);
    }

    const texteArtisan = construireMessageArtisan(donnees);
    await envoyerSms(client.artisanPhoneNumber, client.twilioFromNumber, texteArtisan);
    console.log(`SMS artisan envoye (${donnees.urgence}) pour ${donnees.nomClient} [client: ${client.companyName}].`);

    // SMS de confirmation au CLIENT : independant du SMS artisan ci-dessus. Une erreur
    // ici (numero absent ou echec Twilio) est loguee mais ne fait pas planter le
    // serveur ni echouer la reponse au webhook - le SMS artisan est deja parti.
    let smsClientEnvoye = false;
    if (!donnees.numeroAppelant) {
      console.error("Impossible d'envoyer le SMS de confirmation client : numero de l'appelant introuvable dans le payload Vapi (ni message.customer.number, ni message.call.customer.number).");
    } else {
      try {
        const texteClient = construireMessageClient(donnees, client.companyName);
        await envoyerSms(donnees.numeroAppelant, client.twilioFromNumber, texteClient);
        console.log(`SMS de confirmation envoye au client (${donnees.numeroAppelant}).`);
        smsClientEnvoye = true;
      } catch (err) {
        const detail = err.response ? err.response.data : err.message;
        console.error('Erreur lors de l\'envoi du SMS de confirmation au client :', detail);
      }
    }

    return res.status(200).json({ status: 'ok', smsArtisanEnvoye: true, smsClientEnvoye });
  } catch (err) {
    const detail = err.response ? err.response.data : err.message;
    console.error('Erreur lors du traitement du webhook / envoi SMS Twilio :', detail);
    return res.status(500).json({ status: 'error', message: 'Echec du traitement du webhook, voir logs serveur' });
  }
});

// Verification rapide que le serveur tourne (pratique pour les checks de deploiement).
// COMPANY_NAME n'existe plus en global (multi-tenant) : on rapporte a la place le
// nombre de clients charges depuis le registre.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', clientsCharges: clientsParAssistantId.size });
});

// === RECAP HEBDOMADAIRE ===

// Debut (approx.) de la semaine courante. Suppose que cette fonction est appelee un
// vendredi (le job cron ci-dessous ne tourne que ce jour-la) : "lundi" est donc toujours
// a 4 jours avant "maintenant". Approximation en jours civils UTC plutot qu'en minuit
// exact heure de Paris - peut deriver d'1h autour d'un changement d'heure (DST),
// acceptable pour un recap hebdomadaire non-critique (pas un calcul de facturation).
function debutSemaineCourante(maintenant) {
  const JOURS_DEPUIS_LUNDI_UN_VENDREDI = 4;
  const debut = new Date(maintenant);
  debut.setUTCDate(debut.getUTCDate() - JOURS_DEPUIS_LUNDI_UN_VENDREDI);
  debut.setUTCHours(0, 0, 0, 0);
  return debut;
}

// Pour chaque client du registre, calcule le bilan de la semaine ecoulee a partir de
// data/appels.json et envoie un SMS recap a l'artisan. Chaque envoi est independant :
// l'echec d'un client (numero/expediteur invalide, etc.) n'empeche pas les suivants.
// Sous ce seuil, le recap hebdomadaire n'est pas envoye (evite de deranger l'artisan
// pour une semaine quasi vide).
const SEUIL_MINIMUM_APPELS_RECAP = 5;

async function envoyerRecapHebdomadaire() {
  console.log('Demarrage du recap hebdomadaire...');
  const maintenant = new Date();
  const debutSemaine = debutSemaineCourante(maintenant);
  const tousLesAppels = chargerAppels();

  for (const client of clientsParAssistantId.values()) {
    const appelsClient = tousLesAppels.filter((appel) => {
      if (appel.assistantId !== client.assistantId) return false;
      const instant = Date.parse(appel.date);
      return !Number.isNaN(instant) && instant >= debutSemaine.getTime() && instant <= maintenant.getTime();
    });

    const total = appelsClient.length;
    if (total < SEUIL_MINIMUM_APPELS_RECAP) {
      console.log(`Pas assez d'appels cette semaine pour ${client.companyName} — recap non envoyé`);
      continue;
    }

    const urgences = appelsClient.filter((appel) => appel.urgence === 'URGENT').length;
    const nonUrgences = total - urgences;
    const minutesEconomisees = total * 3;
    const prenomArtisan = (client.artisanName || 'artisan').trim().split(/\s+/)[0];

    const texte = [
      `Bonjour ${prenomArtisan}, voici le bilan Callago de cette semaine :`,
      `📞 ${total} appels pris en charge`,
      `🔴 ${urgences} urgences signalées`,
      `🟢 ${nonUrgences} demandes non urgentes`,
      `⏱ ~${minutesEconomisees} minutes économisées`,
      `À la semaine prochaine — Callago`,
    ].join('\n');

    try {
      await envoyerSms(client.artisanPhoneNumber, client.twilioFromNumber, texte);
      console.log(`Recap hebdomadaire envoye a ${client.companyName} (${total} appels).`);
    } catch (err) {
      const detail = err.response ? err.response.data : err.message;
      console.error(`Erreur lors de l'envoi du recap hebdomadaire a ${client.companyName} :`, detail);
    }
  }

  console.log('Recap hebdomadaire termine.');
}

// Planifie le recap chaque vendredi a 18h00, heure de Paris (node-cron gere le DST
// via l'option timezone). Si JOURS_DEPUIS_LUNDI_UN_VENDREDI ci-dessus doit changer,
// mettre a jour cette expression cron en meme temps (elle doit rester un vendredi).
cron.schedule('0 18 * * 5', envoyerRecapHebdomadaire, { timezone: 'Europe/Paris' });
console.log('Job recap hebdomadaire planifie : chaque vendredi a 18h00 (Europe/Paris).');

const port = PORT || 3000;
app.listen(port, () => {
  console.log(`Serveur webhook Vapi -> Twilio demarre sur le port ${port} (POST /webhook)`);
});
