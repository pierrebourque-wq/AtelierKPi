// Avis de nouvelle demande AtelierKPi.
// Netlify lance cette fonction à chaque demande de formulaire vérifiée (nom de fichier « submission-created »).
// Elle envoie un courriel SIMPLE, sans aucun lien : Proton refuse les avis de Netlify qui contiennent
// le lien du fichier joint (domaine cloudfront.net partagé, mal noté par les filtres anti-pourriel).
//
// Variables d'environnement à définir dans Netlify (Project configuration → Environment variables) :
//   GMAIL_USER          adresse Gmail qui envoie l'avis
//   GMAIL_APP_PASSWORD  mot de passe d'application Google (16 caractères)
//   NOTIF_TO            adresse qui reçoit l'avis (Proton)

const nodemailer = require("nodemailer");

// Champs techniques à ne pas mettre dans l'avis
const IGNORES = new Set(["ip", "user_agent", "referrer", "subject", "form-name", "bot-field"]);

const LIBELLES = {
  nom: "Nom", email: "Courriel", type: "Type", description: "Description",
  commande: "Commande", telephone: "Téléphone", quantite: "Quantité", couleur: "Couleur",
  remise: "Remise", adresse: "Adresse", note: "Note", total: "Total",
};

// Désactive les liens qu'un client aurait tapés (sinon le filtre de Proton pourrait bloquer l'avis)
function sansLiens(texte) {
  return String(texte).replace(/https?:\/\//gi, "").replace(/www\./gi, "www .");
}

function nomFichier(v) {
  if (!v) return "";
  if (typeof v === "object") return v.filename || v.name || "(fichier)";
  // Parfois Netlify ne donne que l'URL : on n'en garde que le nom
  try { return decodeURIComponent(String(v).split("/").pop()); } catch { return "(fichier)"; }
}

function construireAvis(payload) {
  const data = payload.data || {};
  const formulaire = payload.form_name || data["form-name"] || "demande";
  const lignes = [`Nouvelle ${formulaire === "commande" ? "commande" : "demande"} reçue sur atelierkpi.ca`, ""];
  const fichiers = [];

  for (const [cle, valeur] of Object.entries(data)) {
    if (IGNORES.has(cle) || valeur === "" || valeur == null) continue;
    if (/^fichier\d*$/i.test(cle)) { const n = nomFichier(valeur); if (n) fichiers.push(n); continue; }
    const libelle = LIBELLES[cle] || cle;
    const texte = sansLiens(typeof valeur === "object" ? JSON.stringify(valeur) : valeur);
    lignes.push(texte.includes("\n") || texte.length > 70 ? `${libelle} :\n${texte}\n` : `${libelle} : ${texte}`);
  }

  lignes.push("");
  lignes.push(fichiers.length
    ? `Fichiers joints (${fichiers.length}) : ${fichiers.map(sansLiens).join(", ")}\nLes fichiers sont à voir dans Netlify, section Forms.`
    : "Aucun fichier joint.");

  const sujet = sansLiens(data.subject || `${formulaire === "commande" ? "Commande" : "Demande"} AtelierKPi — ${data.nom || "client"}`);
  return { sujet, texte: lignes.join("\n"), repondreA: data.email };
}

exports.construireAvis = construireAvis;

exports.handler = async (event) => {
  const { GMAIL_USER, GMAIL_APP_PASSWORD, NOTIF_TO } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !NOTIF_TO) {
    console.error("Variables GMAIL_USER, GMAIL_APP_PASSWORD ou NOTIF_TO manquantes : avis non envoyé.");
    return { statusCode: 200, body: "config manquante" };
  }

  const { payload } = JSON.parse(event.body || "{}");
  const avis = construireAvis(payload || {});

  const transport = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD.replace(/\s+/g, "") },
  });

  try {
    await transport.sendMail({
      from: `"Site AtelierKPi" <${GMAIL_USER}>`,
      to: NOTIF_TO,
      replyTo: avis.repondreA || undefined,
      subject: avis.sujet,
      text: avis.texte,
    });
    console.log("Avis envoyé :", avis.sujet);
  } catch (err) {
    // On ne fait jamais échouer la demande du client : on note l'erreur dans les journaux de la fonction.
    console.error("Échec de l'envoi de l'avis :", err.message);
  }
  return { statusCode: 200, body: "ok" };
};
