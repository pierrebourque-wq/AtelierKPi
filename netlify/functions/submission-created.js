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

function urlFichier(v) {
  if (!v) return null;
  if (typeof v === "object") return v.url || null;
  return /^https:\/\//i.test(String(v)) ? String(v) : null;
}

function construireAvis(payload) {
  const data = payload.data || {};
  const formulaire = payload.form_name || data["form-name"] || "demande";
  const lignes = [`Nouvelle ${formulaire === "commande" ? "commande" : "demande"} reçue sur atelierkpi.ca`, ""];
  const fichiers = [];
  const aJoindre = [];

  for (const [cle, valeur] of Object.entries(data)) {
    if (IGNORES.has(cle) || valeur === "" || valeur == null) continue;
    if (/^fichier\d*$/i.test(cle)) {
      const n = nomFichier(valeur);
      if (n) { fichiers.push(n); const u = urlFichier(valeur); if (u) aJoindre.push({ filename: n, url: u }); }
      continue;
    }
    const libelle = LIBELLES[cle] || cle;
    const texte = sansLiens(typeof valeur === "object" ? JSON.stringify(valeur) : valeur);
    lignes.push(texte.includes("\n") || texte.length > 70 ? `${libelle} :\n${texte}\n` : `${libelle} : ${texte}`);
  }

  lignes.push("");
  lignes.push(fichiers.length
    ? `Fichiers joints (${fichiers.length}) : ${fichiers.map(sansLiens).join(", ")}`
    : "Aucun fichier joint.");

  const sujet = sansLiens(data.subject || `${formulaire === "commande" ? "Commande" : "Demande"} AtelierKPi — ${data.nom || "client"}`);
  return { sujet, texte: lignes.join("\n"), repondreA: data.email, aJoindre };
}

// Télécharge les fichiers du client pour les mettre en VRAIES pièces jointes (aucun lien dans le courriel).
// Limite totale de 20 Mo (Gmail accepte 25 Mo par message).
const MAX_TOTAL = 20 * 1024 * 1024;
async function telechargerPiecesJointes(liste) {
  const pieces = [];
  const ratees = [];
  let total = 0;
  for (const f of liste) {
    try {
      const r = await fetch(f.url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const contenu = Buffer.from(await r.arrayBuffer());
      if (total + contenu.length > MAX_TOTAL) { ratees.push(`${f.filename} (trop gros)`); continue; }
      total += contenu.length;
      pieces.push({ filename: f.filename, content: contenu, contentType: r.headers.get("content-type") || undefined });
    } catch (err) {
      ratees.push(`${f.filename} (${err.message})`);
    }
  }
  return { pieces, ratees };
}
exports.telechargerPiecesJointes = telechargerPiecesJointes;

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

  const { pieces, ratees } = await telechargerPiecesJointes(avis.aJoindre);
  let texte = avis.texte;
  if (ratees.length) texte += `\nNon joints (à voir dans Netlify, section Forms) : ${ratees.join(", ")}`;

  const message = {
    from: `"Site AtelierKPi" <${GMAIL_USER}>`,
    to: NOTIF_TO,
    replyTo: avis.repondreA || undefined,
    subject: avis.sujet,
  };

  try {
    await transport.sendMail({ ...message, text: texte, attachments: pieces });
    console.log(`Avis envoyé avec ${pieces.length} pièce(s) jointe(s) :`, avis.sujet);
  } catch (err) {
    // Gmail peut refuser une pièce jointe (type interdit, taille) : on renvoie l'avis sans les fichiers.
    console.error("Échec avec pièces jointes :", err.message);
    try {
      await transport.sendMail({ ...message, text: texte + "\n\nLes fichiers n'ont pas pu être joints : voir Netlify, section Forms." });
      console.log("Avis envoyé sans pièces jointes :", avis.sujet);
    } catch (err2) {
      // On ne fait jamais échouer la demande du client : l'erreur reste dans les journaux de la fonction.
      console.error("Échec de l'envoi de l'avis :", err2.message);
    }
  }
  return { statusCode: 200, body: "ok" };
};
