# Talk — English practice PWA

Application vocale simple pour t'entraîner à parler anglais avec une IA, en PWA installable sur Android.

## 1. Récupérer une clé Groq (gratuite, illimitée en usage normal)

1. Va sur https://console.groq.com/keys
2. Connecte-toi (email ou Google), pas de carte bancaire demandée
3. Crée une clé, elle commence par `gsk_...`
4. Garde-la de côté, tu la colleras dans les réglages de l'appli

Limite gratuite : ~30 requêtes/minute, 1000/jour. Une conversation vocale normale (une phrase toutes les quelques secondes) reste très en dessous.

## 2. Déployer l'appli (HTTPS obligatoire pour l'installer sur le téléphone)

Le plus simple et gratuit : **GitHub Pages**.

1. Crée un nouveau repo GitHub (public, gratuit)
2. Mets-y les fichiers de ce dossier (`index.html`, `app.js`, `styles.css`, `manifest.json`, `sw.js`, `icons/`)
3. Dans les réglages du repo → Pages → Source = branche principale, dossier `/root`
4. GitHub te donne une URL du type `https://tonpseudo.github.io/talk/`

Alternatives tout aussi gratuites : Netlify Drop (glisser-déposer le dossier) ou Vercel.

## 3. Installer sur le téléphone Android

1. Ouvre l'URL HTTPS dans Chrome sur ton téléphone
2. Menu ⋮ → "Ajouter à l'écran d'accueil" / "Installer l'application"
3. L'icône apparaît comme une vraie app

## 4. Premier lancement

1. Ouvre l'appli, tape sur l'icône ⚙ en haut à droite
2. Colle ta clé Groq
3. (Optionnel) précise un sujet de conversation, choisis une voix anglaise et une vitesse de parole
4. Ferme les réglages, tape sur le bouton **TALK** au centre

L'IA lance la conversation elle-même, tu réponds à voix haute, elle enchaîne — comme une vraie discussion. Le cercle change de couleur : turquoise = elle t'écoute, gris = elle réfléchit, orange = elle parle.

Le bouton "End conversation" en bas arrête tout proprement.

## Notes techniques

- La reconnaissance vocale utilise l'API native du navigateur (Web Speech API), très performante sur Chrome Android — mais elle nécessite une connexion internet (c'est Google qui fait la reconnaissance côté serveur, gratuitement, sans limite).
- La voix de l'IA (synthèse vocale) est 100% native et fonctionne même hors-ligne.
- Le fichier `sw.js` met en cache l'interface pour un chargement instantané, mais les appels à l'IA nécessitent toujours internet.
- Ta clé API et l'historique de conversation restent uniquement sur ton téléphone (`localStorage`/`sessionStorage`), rien n'est envoyé ailleurs qu'à Groq.
- Le modèle utilisé est `llama-3.3-70b-versatile` — tu peux le changer dans `app.js` (`GROQ_MODEL`) si tu veux tester `llama-3.1-8b-instant` (plus rapide, un peu moins fin) par exemple.

## Limite connue

Safari/iOS n'est pas supporté (reconnaissance vocale absente en PWA sur iOS) — cette version cible Android/Chrome comme demandé.
