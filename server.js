//------------------------------------------------------------------
// SPECIAL HISENS
//
//------------------------------------------------------------------
const express = require('express');
const playwright = require('playwright');
const { promises: fsPromises } = require('fs');
const fs = require('fs');
const path = require('path');
const ini = require('ini');
const os = require('os');
const listEndpoints = require('express-list-endpoints');
const JSZip = require('jszip');
const fetch = require('node-fetch');
const { exec } = require('child_process');

// Création de l'application Express
const app = express();

// Variables globales
const VERSION = "1.0.4"; // Version mise à jour
const tizenFilePath = path.join(__dirname, 'images', 'hisens.jpeg');
let browserLaunch = null;
let page = null;
let context = null;
let pathBrowserExecutable = null;
let userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
let setVideo = false;
let debugBrowser = true;
let waitKeyboard = 0;
let isRunning = false; // nom de variable plus clair
let networkRequests = []
let networkResponses = []; // Reset networkResponses

// Chemins importants
const CONFIG_FILE_PATH = path.join(__dirname, 'config/config.ini');
const VIDEOS_DIR = path.join(__dirname, 'videos');
const TRACES_DIR = path.join(__dirname, 'traces');
const COOKIES_DIR = path.join(__dirname, 'cookies');

// Création des dossiers s'ils n'existent pas
[VIDEOS_DIR, COOKIES_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});



// Lecture asynchrone de la configuration INI
async function readConfig(filePath) {
    try {
        const data = await fsPromises.readFile(filePath, 'utf-8');
        return ini.parse(data);
    } catch (err) {
        console.error('Erreur de lecture du fichier INI:', err);
        throw err;
    }
}

// Démarrage du serveur avec la configuration
async function initServer() {
    try {
        const config = await readConfig(CONFIG_FILE_PATH);
        const port = config.portFlask?.port;
        waitKeyboard = (config.waitKeyboard?.timeKeyboard || 0) * 1000;

        if (!port) throw new Error("Port non défini dans la config");

        app.listen(port, () => {
            console.log(`Serveur Express démarré sur le port ${port}`);
        });
    } catch (err) {
        console.error("Erreur lors de l'initialisation:", err);
        process.exit(1); // Arrêt propre en cas d'erreur critique
    }
}

// Lancement de l'initialisation
initServer();

// Vidage du dossier en utilisant fs.promises
async function emptyDirectory(directory) {
    try {
        const files = await fsPromises.readdir(directory);
        await Promise.all(files.map(async file => {
            const filePath = path.join(directory, file);
            const stat = await fsPromises.stat(filePath);
            if (stat.isDirectory()) {
                await emptyDirectory(filePath);
                await fsPromises.rmdir(filePath);
            } else {
                await fsPromises.unlink(filePath);
            }
        }));
        console.log(`Dossier ${directory} vidé avec succès`);
    } catch (err) {
        console.error("Erreur lors du vidage du dossier:", err);
    }
}

// Middleware pour vérifier que la page existe
function ensurePageExists(handler) {
    return async (req, res) => {
        if (!page) {
            return res.status(500).json({
                success: false,
                message: 'Navigateur non initialisé. Veuillez d\'abord appeler /setBrowser'
            });
        }
        try {
            await handler(req, res);
        } catch (error) {
            console.error(`Erreur dans le handler: ${error.message}`);
            res.status(500).json({
                success: false,
                message: `Erreur: ${error.message}`
            });
        }
    };
}

// ----------------------- GESTION DES COOKIES ----------------------------

function readCookiesFromJSON(filePath) {
    try {
        console.log("Lecture des cookies depuis:", filePath);
        if (!fs.existsSync(filePath)) {
            console.warn(`Le fichier de cookies ${filePath} n'existe pas`);
            return [];
        }

        const jsonData = fs.readFileSync(filePath, { encoding: 'utf-8' });
        let cookies = JSON.parse(jsonData);

        // On vérifie si le cooses a été stocké globalement
        if (global.coosesValue) {
            // Recherche du cookie wassup qui contient la valeur de cooses
            const wassupCookieIndex = cookies.findIndex(cookie =>
                cookie.name === 'wassup' && cookie.domain === '.orange.fr'
            );

            if (wassupCookieIndex !== -1) {
                console.log("Remplacement du cooses dans le cookie wassup");
                // On remplace la valeur actuelle par celle récupérée
                cookies[wassupCookieIndex].value = global.coosesValue;
            }
        }

        return cookies;
    } catch (err) {
        console.error("Erreur lors de la lecture du fichier JSON:", err);
        return [];
    }
}

async function setCookies(context, cookies) {
    if (!cookies || cookies.length === 0) {
        console.log('Aucun cookie à définir');
        return;
    }

    console.log(`Définition de ${cookies.length} cookies...`);
    await context.addCookies(cookies);
    console.log('Cookies définis avec succès');
}

// ----------------------- AUTHENTIFICATION ORANGE ----------------------------

async function loadCredentials() {
    try {
        const jsonFilePath = path.join(__dirname, 'config/comptes.json');
        const jsonData = await fsPromises.readFile(jsonFilePath, 'utf8');
        return JSON.parse(jsonData);
    } catch (error) {
        console.error('Erreur lors du chargement des identifiants:', error);
        throw error;
    }
}

async function findPasswordForEmail(email) {
    try {
        const credentials = await loadCredentials();
        const account = credentials.comptes.find(account => account.email === email);

        if (account) {
            return account.password;
        } else {
            throw new Error(`Aucun mot de passe trouvé pour l'email: ${email}`);
        }
    } catch (error) {
        console.error('Erreur lors de la recherche du mot de passe:', error);
        throw error;
    }
}

function extractCoosesValue(xmlResponse) {
    if (!xmlResponse || typeof xmlResponse !== 'string') {
        console.error('La réponse XML est invalide ou vide');
        return null;
    }

    const coosesRegex = /<ident name="cooses" value="([^"]+)"/;
    const match = xmlResponse.match(coosesRegex);

    if (match && match[1]) {
        return match[1];
    } else {
        console.error('Impossible de trouver la valeur de cooses dans la réponse XML');
        return null;
    }
}

async function estNumeroTelephone(valeur) {
    // Vérifie si la valeur contient uniquement des chiffres
    return /^\d+$/.test(valeur);
}

async function requestOrangeSSO(email) {
    if (!email) {
        console.warn("Aucun email fourni pour l'authentification Orange SSO");
        return null;
    }

    // Variable globale pour stocker la valeur de cooses entre les appels de fonction
    global.coosesValue = null;

    // Trouver le mot de passe correspondant à l'email
    let password;
    try {
        password = await findPasswordForEmail(email);
        console.log(`Mot de passe trouvé pour ${email}`);
    } catch (error) {
        console.error(error.message);
        return null;
    }

    // URL et paramètres de requête
    const baseUrl = 'https://sso.orange.fr/WT/userinfo/';
    const params = new URLSearchParams({
        'serv': 'VODOOB',
        'info': 'cooses',
        'wt-cvt': '4',
        'wt-cooses': '',
        'wt-mco': 'MCO=OFR'
    });
    const url = `${baseUrl}?${params.toString()}`;

    let payload
    const statusEmail = await estNumeroTelephone(email)

    if (statusEmail) {
        // Données d'authentification
        payload = new URLSearchParams({
            'wt-msisdn': email,
            'wt-pwd': password
        });
    } else {
        // Données d'authentification
        payload = new URLSearchParams({
            'wt-email': email,
            'wt-pwd': password
        });
    }

    // Headers
    const headers = {
        'x-auth-token': '9nqeZkntT55CEydKNhVScg',
        'Content-Type': 'application/x-www-form-urlencoded'
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: payload.toString()
        });

        console.log("Statut de la réponse SSO:", response.status);

        if (!response.ok) {
            throw new Error(`Erreur SSO: ${response.status} ${response.statusText}`);
        }

        const text = await response.text();

        // Extraire et stocker la valeur de cooses
        const coosesValue = extractCoosesValue(text);

        if (coosesValue) {
            global.coosesValue = coosesValue;
            console.log("Valeur de cooses récupérée avec succès");
            return coosesValue;
        } else {
            console.error("Impossible d'extraire la valeur de cooses");
            return null;
        }
    } catch (error) {
        console.error("Erreur de requête SSO:", error.message);
        return null;
    }
}

// ----------------------- FONCTIONS UTILITAIRES ----------------------------

async function takeScreenshot() {
    try {
        const imgBuffer = await fs.promises.readFile(tizenFilePath);
        return imgBuffer.toString('base64');
    } catch (err) {
        console.error("Erreur lors de la capture d'écran de l'ordinateur:", err);
        throw err;
    }
}

async function injectScriptsToPage(page) {
    // Injection du CSS pour masquer les scrollbars via un MutationObserver
    const hideScrollbarsCss = `
    * {
      scrollbar-width: none !important;
      -ms-overflow-style: none !important;
    }
    *::-webkit-scrollbar {
      display: none !important;
    }
    body, html {
      overflow: hidden !important;
    }
  `;

    await page.addInitScript(css => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
        const observer = new MutationObserver(() => {
            if (!document.head.contains(style)) {
                document.head.appendChild(style);
            }
        });
        observer.observe(document.head, { childList: true });
    }, hideScrollbarsCss);

    // Injection du code pour trouverElement
    await page.addInitScript(() => {
        window.trouverElement = function (x, y) {
            const element = document.elementsFromPoint(x, y)[0];
            if (!element) return null;

            const rect = element.getBoundingClientRect();
            return {
                element: element,
                tag: element.tagName.toLowerCase(),
                id: element.id,
                classes: Array.from(element.classList).join(' '),
                bounds: {
                    x: Math.round(rect.x),
                    y: Math.round(rect.y),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                },
                texte: element.textContent.trim(),
                html: element.innerHTML.trim(),
                outerHtml: element.outerHTML
            };
        };
        console.log('Script trouverElement injecté !');
    });
}

// Constantes pour les mappages de touches
const KEY_MAP = {
    "enter": "Enter",
    "up": "ArrowUp",
    "down": "ArrowDown",
    "left": "ArrowLeft",
    "right": "ArrowRight",
    "tab": "Tab",
    "ShiftTab": "Shift+Tab",
    "home": "Home",
    "F1": "F1"
};

// ----------------------- ROUTES ----------------------------

// Route pour définir le mode vidéo
app.get('/setVideo', (req, res) => {
    const { video } = req.query;
    const videoEnabled = video === 'true';
    console.log(`- setVideo : ${videoEnabled}`);
    setVideo = videoEnabled;
    res.json({ success: true, setVideo });
});

// Route pour définir le mode debug
app.get('/setDebug', (req, res) => {
    const { debug } = req.query;
    const debugEnabled = debug === 'true';
    console.log(`- Mode debug : ${debugEnabled}`);
    debugBrowser = debugEnabled;
    res.json({ success: true, debug: debugEnabled });
});

// Route principale pour initialiser le navigateur
app.get('/setBrowser', async (req, res) => {
    let { browser, url, sizeX, sizeY, razProfile, compte, captureNetwork = "False" } = req.query;
    const raz = (razProfile || '').toLowerCase() === 'true';
    captureNetwork = String(captureNetwork).toLowerCase() === "true";

    console.log("----------------------------------------------");
    console.log(`- Version server   : ${VERSION}`);
    console.log(`- Os plateforme    : ${os.platform()}`);
    console.log(`- Browser          : ${browser}`);
    console.log(`- URL              : ${url}`);
    console.log(`- Dimensions       : ${sizeX}x${sizeY}`);
    console.log(`- Reset Profile    : ${raz}`);
    console.log(`- Compte           : ${compte}`);
    console.log(`- Capture Network  : ${captureNetwork}`);
    console.log(`- Mode vidéo       : ${setVideo}`);
    console.log(`- Délai clavier    : ${waitKeyboard}ms`);
    console.log("----------------------------------------------");

    // Validation des paramètres
    if (!url || !sizeX || !sizeY) {
        return res.status(400).json({
            success: false,
            message: 'URL et dimensions (sizeX, sizeY) sont nécessaires'
        });
    }

    const width = parseInt(sizeX, 10);
    const height = parseInt(sizeY, 10);

    if (isNaN(width) || isNaN(height)) {
        return res.status(400).json({
            success: false,
            message: 'Les dimensions doivent être des nombres valides'
        });
    }

    // Fermer le navigateur existant s'il existe
    if (browserLaunch) {
        isRunning = false;
        try {
            await browserLaunch.close();
            console.log("Navigateur précédent fermé avec succès");
        } catch (error) {
            console.error("Erreur lors de la fermeture du navigateur:", error.message);
        }
    }

    // Préparer le nom de compte pour le fichier de cookies
    let nameCompte = compte || '';
    if (nameCompte.includes("@")) {
        nameCompte = nameCompte.replace("@", "_");
    }

    // Vider le dossier des vidéos
    await emptyDirectory(VIDEOS_DIR);

    try {
        // Lancement du navigateur en fonction du paramètre browser
        switch (browser) {
            case "chrome":
                browserLaunch = await playwright.chromium.launch({
                    headless: false, // Mode visible (non headless)
                    channel: 'chrome', // Utilise Chrome au lieu de Chromium
                    ignoreDefaultArgs: [
                        '--disable-component-update'
                    ],
                    executablePath: '/usr/bin/google-chrome', // Chemin vers Chrome
                    //slowMo: 50 // Ralentit Playwright pour voir les actions
                });
                break;
            case "edge":
                browserLaunch = await playwright.chromium.launch({
                    headless: false,
                    executablePath: pathBrowserExecutable
                });
                break;
            case "firefox":
                browserLaunch = await playwright.firefox.launch({
                    headless: false
                });
                break;
            case "safari":
                browserLaunch = await playwright.webkit.launch({
                    headless: false
                });
                break;
            default:
                return res.status(400).json({
                    success: false,
                    message: 'Navigateur non supporté. Options: chrome, edge, firefox, safari'
                });
        }

        // Configuration du contexte de navigation
        let options = {
            viewport: { width, height },
            userAgent
        };

        if (browser === "chrome") {
            options.isMobile = true;
        }

        if (setVideo) {
            options.recordVideo = { dir: VIDEOS_DIR };
        }

        if (debugBrowser) {
            options.recordHar = { path: path.join(VIDEOS_DIR, 'trace.har') };
        }

        context = await browserLaunch.newContext(options);

        // Démarrer le traçage si le mode debug est activé
        if (debugBrowser) {
            await context.tracing.start({
                screenshots: true,
                snapshots: true
            });
        }

        // Récupérer la valeur cooses pour le compte si un compte est fourni
        if (compte) {
            try {
                await requestOrangeSSO(compte);
                if (global.coosesValue) {
                    console.log("Valeur cooses récupérée avec succès");
                }
            } catch (err) {
                console.error("Erreur lors de la récupération du cooses:", err.message);
            }
        }

        // Charger les cookies si razProfile est false
        if (!raz && nameCompte) {
            const cookieFile = path.join(COOKIES_DIR, `${nameCompte}.json`);
            try {
                const cookies = readCookiesFromJSON(cookieFile);
                if (cookies.length > 0) {
                    await setCookies(context, cookies);
                    console.log("Cookies chargés avec succès");
                } else {
                    console.log("Aucun cookie trouvé ou fichier vide");
                }
            } catch (err) {
                console.error("Erreur lors du chargement des cookies:", err.message);
            }
        }

        // Création d'une nouvelle page
        page = await context.newPage();
        isRunning = true;

        // Écouter les requêtes et réponses réseau
        if (captureNetwork) {
            page.on('request', request => {
                const requestData = {
                    url: request.url(),
                    method: request.method(),
                    resourceType: request.resourceType(),
                    headers: request.headers(),
                    postData: request.postData(),
                    timestamp: Date.now()
                };
                networkRequests.push(requestData);
            });

            // Écouter toutes les réponses réseau sans filtre
            page.on('response', async response => {
                const url = response.url();
                const responseData = {
                    url: url,
                    status: response.status(),
                    headers: response.headers(),
                    requestHeaders: response.request().headers(), // Capture request headers
                    timestamp: Date.now()
                };

                // Tenter de récupérer le corps de la réponse si c'est du JSON
                try {
                    const responseBody = await response.json();
                    responseData.body = responseBody;
                } catch (err) {
                    responseData.body = null;
                    responseData.error = err.message;
                }

                networkResponses.push(responseData);
            });
        }

        // Injection des scripts nécessaires
        await injectScriptsToPage(page);

        // Navigation vers l'URL spécifiée
        await page.goto(url, { waitUntil: 'domcontentloaded' });

        // NOUVEAU : Check pour le bouton "Continuer" et clic si présent
        await page.waitForTimeout(500); // Délai pour stabiliser avant le check
        const continuerButton = page.locator('button:has-text("Continuer")');
        const buttonVisible = await continuerButton.isVisible({ timeout: 5000 }).catch(() => false);
        if (buttonVisible) {
            console.log('Bouton "Continuer" détecté → Clic effectué');
            await continuerButton.click();
            await page.waitForTimeout(500); // Délai après clic pour que la page réagisse
        } else {
            console.log('Aucun bouton "Continuer" trouvé, passage à la suite');
        }

        await page.waitForTimeout(1000); // Attente stabilisation avant le check suivant

        /*
        ***********************************************************************************
        Palliatif temporaire pour gérer la modale de consentement des cookies
        */

        // Récupérer l'URL actuelle
        const currentUrl = page.url();
        console.log("URL actuelle après navigation:", currentUrl);

        // Vérifier si l'URL contient "consent-notice"
        const containsConsentNotice = currentUrl.includes('consent-notice');
        console.log("Présence de 'consent-notice' dans l'URL :", containsConsentNotice);

        if (containsConsentNotice) {
            // Envoyer la flèche vers le bas deux fois
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('ArrowDown');
            await page.waitForTimeout(200); // AJOUT : Délai pour laisser l'UI naviguer

            // Cliquer sur le texte "Tout accepter et fermer" (avec check visibilité)
            const acceptText = page.getByText('Tout accepter et fermer', { exact: true }); // exact: true pour précision
            const textVisible = await acceptText.isVisible({ timeout: 3000 }).catch(() => false);
            if (textVisible) {
                console.log('Texte "Tout accepter et fermer" détecté → Clic effectué');
                await acceptText.click();
                await page.waitForTimeout(500); // Délai après clic pour fermer la modale
            } else {
                console.log('Texte "Tout accepter et fermer" non trouvé');
            }
        }

        /*
        ***********************************************************************************
        */


        await page.evaluate(() => {
            localStorage.setItem('GothamStvStore/FIRST_BOOT_DONE', 'true');
            localStorage.setItem('GothamStvStore_EMU/FIRST_BOOT_DONE', 'true');
            console.log('localStorage initialisé avec succès');
        });

        let application_dispo = !(await page.locator('text=Application is not available').isVisible()); // true si texte absent, false sinon

        if (!application_dispo) {
            console.error("L'application n'est pas disponible");
            return res.json({
                success: false,
                width: null,
                height: null,
                message: `BFF non disponible`
            });
        }

        let application_enroll = !(await page.waitForTimeout(2000).then(() => page.locator('text=Bienvenue sur Orange').isVisible()));

        if (!application_enroll && !raz) {
            console.error("Enroll présent");
            return res.json({
                success: false,
                width: null,
                height: null,
                message: `Enroll présent`
            });
        }

        // Vérification des dimensions réelles du viewport
        const actualSize = await page.viewportSize();

        if (actualSize.width === width && actualSize.height === height) {
            console.log(`Navigateur lancé avec la taille spécifiée : ${width}x${height}`);
            return res.json({
                success: true,
                width: actualSize.width,
                height: actualSize.height,
                message: `Navigateur lancé et cookies définis`
            });
        } else {
            console.log(`Problème de dimension: ${actualSize.width}x${actualSize.height}`);
            return res.json({
                success: false,
                width: actualSize.width,
                height: actualSize.height,
                message: `Problème dimension navigateur`
            });
        }
    } catch (error) {
        console.error("Erreur lors de l'initialisation du navigateur:", error);
        return res.status(500).json({
            success: false,
            message: `Erreur: ${error.message}`
        });
    }
});

// Route pour récupérer la réponse réseau
app.get('/getNetworkResponse', (req, res) => {
    const targetKeyword = req.query.targetKeyword;

    console.log("Word : ", targetKeyword);

    if (!targetKeyword) {
        return res.json({
            success: false,
            message: "targetKeyword est requis"
        });
    }

    const matchingResponses = networkResponses
        .filter(response => response.url.toLowerCase().includes(targetKeyword.toLowerCase()))
        .map(response => ({
            url: response.url,
            status: response.status,
            headers: response.headers,
            requestHeaders: response.requestHeaders, // Include request headers
            body: response.body,
            timestamp: response.timestamp,
            urlMatches: true
        }));

    if (matchingResponses.length === 0) {
        return res.json({
            success: false,
            message: `Aucune réponse avec ${targetKeyword} dans l'URL`
        });
    }

    return res.json({
        success: true,
        responses: matchingResponses,
        total: matchingResponses.length
    });
});

// Route pour trouver un élément aux coordonnées spécifiées
app.get('/findElement', ensurePageExists(async (req, res) => {
    const { x, y } = req.query;

    if (!x || !y) {
        return res.status(400).json({
            success: false,
            message: 'Les coordonnées x et y sont requises'
        });
    }

    try {
        const element = await page.evaluate(
            ({ x, y }) => window.trouverElement(parseInt(x), parseInt(y)),
            { x, y }
        );

        if (!element) {
            return res.json({
                success: false,
                message: 'Aucun élément trouvé à ces coordonnées'
            });
        }

        res.json({
            success: true,
            element: element
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la recherche de l\'élément',
            error: error.message
        });
    }
}));

// Route pour prendre une capture d'écran
app.get('/screenshot', async (req, res) => {
    const currentTimeInSeconds = Date.now() / 1000;

    // Vérifier immédiatement si page est valide ou si le navigateur est en cours d'exécution
    if (!page || !isRunning || page.isClosed()) {
        console.warn('Page invalide ou fermée, tentative de capture d’écran du bureau');
        try {
            const base64Image = await takeScreenshot();
            return res.json({ data: base64Image, time: currentTimeInSeconds });
        } catch (err) {
            console.error('Erreur dans takeScreenshot:', err);
            return res.status(500).json({ error: err.message, time: currentTimeInSeconds });
        }
    }

    try {
        // Attendre que la page soit complètement chargée avec un timeout raisonnable
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(error => {
            console.warn('Délai dépassé ou erreur lors du chargement de la page:', error.message);
            // Ne pas bloquer ici, tenter la capture malgré l'erreur
        });

        // Nouvelle vérification après waitForLoadState pour s'assurer que la page est toujours ouverte
        if (page.isClosed()) {
            isRunning = false;
            throw new Error('La page a été fermée pendant l’attente');
        }

        // Prendre la capture d'écran
        const screenshotBuffer = await page.screenshot({
            type: 'jpeg',
            quality: 100,
            scale: "css"
        });

        console.log('Capture d’écran réussie');
        return res.json({
            data: screenshotBuffer.toString('base64'),
            time: currentTimeInSeconds
        });
    } catch (err) {
        console.error("Erreur lors de la capture d'écran:", err.message);
        // Si l'erreur est liée à une fermeture, mettre à jour isRunning
        if (err.message.includes('Target page, context or browser has been closed') || page.isClosed()) {
            isRunning = false;
            console.warn('Mise à jour de isRunning à false en raison de la fermeture de la page');
        }
        return res.status(500).json({
            error: err.message,
            time: currentTimeInSeconds
        });
    }
});

// Route pour ouvrir un nouvel onglet
app.get('/setTab', async (req, res) => {
    if (!context) {
        return res.status(500).json({
            success: false,
            message: 'Contexte non initialisé'
        });
    }

    try {
        page = await context.newPage();
        console.log("Nouvel onglet ouvert");
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: `Erreur lors de l'ouverture d'un nouvel onglet: ${error.message}`
        });
    }
});

// Route pour récupérer les onglets ouverts
app.get('/getTabs', ensurePageExists(async (req, res) => {
    try {
        const pages = context.pages();
        const titres = await Promise.all(pages.map(p => p.title()));
        console.log(`Nombre d'onglets: ${titres.length}`);
        res.json({ success: true, onglets: titres });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: `Erreur lors de la récupération des onglets: ${error.message}`
        });
    }
}));

// Route pour aller à un onglet spécifique
app.get('/goTab', async (req, res) => {
    if (!context) {
        return res.status(500).json({
            success: false,
            message: 'Contexte non initialisé'
        });
    }

    const tab = parseInt(req.query.tab, 10);

    if (isNaN(tab)) {
        return res.status(400).json({
            success: false,
            message: "Numéro d'onglet invalide"
        });
    }

    try {
        // Attendre un court délai pour s'assurer que les onglets sont stables
        await new Promise(resolve => setTimeout(resolve, 2000));

        const pages = context.pages();

        if (tab >= 0 && tab < pages.length) {
            page = pages[tab];
            await page.bringToFront();
            return res.json({ success: true });
        } else {
            return res.status(404).json({
                success: false,
                message: "Onglet non trouvé"
            });
        }
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: `Erreur lors du changement d'onglet: ${error.message}`
        });
    }
});

// Route pour fermer un onglet spécifique
app.get('/closeTab', ensurePageExists(async (req, res) => {
    const tab = parseInt(req.query.tab, 10);

    if (isNaN(tab)) {
        return res.status(400).json({
            success: false,
            message: "Numéro d'onglet invalide"
        });
    }

    if (tab === 0) {
        return res.status(400).json({
            success: false,
            message: "Impossible de fermer l'onglet principal (0)"
        });
    }

    try {
        const pages = context.pages();

        if (!pages[tab]) {
            return res.status(404).json({
                success: false,
                message: "Onglet non trouvé"
            });
        }

        // Passer à l'onglet principal avant de fermer l'onglet demandé
        page = pages[0];
        await page.bringToFront();

        // Fermer l'onglet spécifié
        await pages[tab].close();

        return res.json({ success: true });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: `Erreur lors de la fermeture de l'onglet: ${error.message}`
        });
    }
}));

// Route pour récupérer les infos sur les versions
app.get('/getInfos', async (req, res) => {
    try {
        const { version: playwrightVersion } = require('playwright/package.json');

        // Lancer temporairement un navigateur pour obtenir sa version
        const browser = await playwright.chromium.launch({
            headless: true,
            executablePath: '/usr/bin/google-chrome',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-default-browser-check'
            ]
        });

        const browserVersion = await browser.version();
        await browser.close();

        console.log(`Version du navigateur: ${browserVersion}`);

        res.json({
            success: true,
            version_chrome: browserVersion,
            driver_version: playwrightVersion
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: `Erreur lors de la récupération des informations: ${error.message}`
        });
    }
});

// Route pour cliquer à une position spécifique
app.get('/setClick', ensurePageExists(async (req, res) => {
    const { positionX, positionY } = req.query;
    const x = parseInt(positionX, 10);
    const y = parseInt(positionY, 10);

    if (isNaN(x) || isNaN(y)) {
        return res.status(400).json({
            success: false,
            message: "Coordonnées invalides"
        });
    }

    try {
        await page.mouse.click(x, y);

        // Attendre que la page se stabilise après le clic
        await page.waitForLoadState('domcontentloaded').catch(() => {
            console.log("La page ne s'est pas complètement chargée dans le délai imparti");
        });

        // Délai supplémentaire pour laisser le temps à la page de réagir
        await page.waitForTimeout(1000);

        // Délai supplémentaire si le mode vidéo est activé
        if (setVideo) {
            await page.waitForTimeout(1000);
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: `Erreur lors du clic: ${error.message}`
        });
    }
}));

// Route pour déplacer la souris
app.get('/setMouveMouse', ensurePageExists(async (req, res) => {
    const { positionX, positionY } = req.query;
    const x = parseInt(positionX, 10);
    const y = parseInt(positionY, 10);

    if (isNaN(x) || isNaN(y)) {
        return res.status(400).json({
            success: false,
            message: "Coordonnées invalides"
        });
    }

    try {
        await page.mouse.move(x, y);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: `Erreur lors du déplacement de la souris: ${error.message}`
        });
    }
}));

// Route pour appuyer sur une touche
app.get('/setPress', ensurePageExists(async (req, res) => {
    const { key } = req.query;
    console.log("- Touche pressée : ", key)

    if (!key) {
        return res.status(400).json({
            success: false,
            message: "Touche non spécifiée"
        });
    }

    try {
        if (key in KEY_MAP) {
            await page.keyboard.press(KEY_MAP[key]);
            await page.waitForTimeout(waitKeyboard);
        } else if (key === "esc") {
            await page.goBack();
        } else {
            await page.keyboard.type(key);
            await page.waitForTimeout(waitKeyboard);
        }
        res.json({ success: true, key });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: `Erreur lors de l'appui sur la touche: ${error.message}`
        });
    }
}));

// Route pour saisir du texte
app.get('/setText', ensurePageExists(async (req, res) => {
    const { positionX, positionY, text } = req.query;

    if (!text) {
        return res.status(400).json({
            success: false,
            message: "Texte non spécifié"
        });
    }

    try {
        if (text === "Debug player") {
            await page.keyboard.press('Control+Shift+Alt+D');
        } else if (text === "F1") {
            await page.keyboard.press('F1');
        } else {
            // Extraire tout le texte visible de la page
            const pageHTML = await page.content();
            // Compter les occurrences de "search-" (insensible à la casse)
            const count = (pageHTML.match(/search-/gi) || []).length;
            console.log(`Le mot "search-" apparaît ${count} fois sur la page.`);

            if (count >= 3) {
                // Utiliser le clavier virtuel si "search-" apparaît au moins 3 fois
                console.log('Clavier virtuel activé pour la saisie.');
                await typeTextOnKeyboard(page, text, clearFirst = true);
            } else {
                // Sinon, saisie normale (clic + insertText)
                console.log('Saisie normale (sans clavier virtuel).');
                // Cliquer à la position spécifiée si des coordonnées sont fournies
                if (positionX && positionY) {
                    const x = parseInt(positionX, 10);
                    const y = parseInt(positionY, 10);
                    if (!isNaN(x) && !isNaN(y)) {
                        await page.mouse.click(x, y);
                        await page.waitForTimeout(200); // Petit délai après clic
                    }
                }
                // Insérer le texte
                await page.keyboard.insertText(text);
                await page.waitForTimeout(200); // Stabiliser après insertText
            }
        }

        // Réponse unique à la fin : succès global
        res.json({ success: true, message: `Texte "${text}" saisi avec succès (clavier virtuel: ${count >= 3})` });
    } catch (error) {
        console.error('Erreur dans /setText:', error);
        res.status(500).json({
            success: false,
            message: `Erreur lors de la saisie du texte: ${error.message}`
        });
    }
}));

// Route pour redimensionner la fenêtre
app.get('/setResize', ensurePageExists(async (req, res) => {
    const sizeX = parseInt(req.query.sizeX, 10);
    const sizeY = parseInt(req.query.sizeY, 10);

    if (isNaN(sizeX) || isNaN(sizeY)) {
        return res.status(400).json({
            success: false,
            message: 'Les valeurs sizeX et sizeY doivent être des nombres valides.'
        });
    }

    try {
        await page.setViewportSize({ width: sizeX, height: sizeY });

        // Vérifier que le redimensionnement a bien fonctionné
        const newSize = await page.viewportSize();

        if (newSize.width === sizeX && newSize.height === sizeY) {
            return res.json({
                success: true,
                width: newSize.width,
                height: newSize.height
            });
        } else {
            return res.status(500).json({
                success: false,
                message: 'Le redimensionnement a échoué.'
            });
        }
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: `Erreur lors du redimensionnement: ${error.message}`
        });
    }
}));

// Route pour naviguer vers une URL
app.get('/setUrl', ensurePageExists(async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({
            success: false,
            message: "URL non spécifiée"
        });
    }

    try {
        console.log("Navigation vers:", url);

        // Naviguer vers l'URL avec gestion des timeouts
        const response = await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 30000 // 30 secondes maximum pour le chargement
        });

        if (response) {
            return res.json({
                success: true,
                status: response.status(),
                url: response.url()
            });
        } else {
            return res.json({
                success: true,
                message: "Navigation effectuée, mais aucune réponse obtenue"
            });
        }
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: `Erreur lors de la navigation: ${error.message}`
        });
    }
}));

// Route pour obtenir des informations sur le système d'exploitation
app.get('/getOS', async (req, res) => {
    const osInfo = {
        platform: os.platform(),
        release: os.release(),
        type: os.type(),
        arch: os.arch(),
        cpu: os.cpus()[0].model,
        memory: {
            total: Math.round(os.totalmem() / (1024 * 1024 * 1024)) + ' GB',
            free: Math.round(os.freemem() / (1024 * 1024 * 1024)) + ' GB'
        }
    };

    res.json({ success: true, os: osInfo });
});

app.get('/getLabels', ensurePageExists(async (req, res) => {
    try {
        async function scrollToBottom(page) {
            try {
                await page.waitForLoadState('load', { timeout: 10000 });  // 10s max, état 'load'
                console.log("- Page chargée...");
            } catch (error) {
                console.log("- Erreur de chargement, on continue quand même :", error.message);
            }

            // Le reste du code...
            for (let i = 0; i < 22; i++) {
                await page.locator('.strips').focus().catch(() => page.locator('#app').focus());
                await page.keyboard.press('ArrowDown');
                console.log(`-- ArrowDown press ${i + 1}/22`);
            }

            console.log('Completed 22 ArrowDown key presses.');  // Note : c'était 30 dans le log, mais boucle à 22
        }

        // Exécuter le défilement
        await scrollToBottom(page);

        // Récupérer les éléments avec l'XPath dans l'ordre du DOM
        const trackIds = await page.evaluate(() => {
            const xpath = '//*[starts-with(@id, "slider") and contains(@id, "track")]';
            const result = document.evaluate(
                xpath,
                document,
                null,
                XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
                null
            );
            const elements = [];
            for (let i = 0; i < result.snapshotLength; i++) {
                elements.push(result.snapshotItem(i));
            }
            return elements.map(el => el.id);
        });

        // Construire la liste des labels au format demandé
        const labels = trackIds.map(trackId => [trackId]);

        // Calculer le total
        const totalElements = trackIds.length;

        // Afficher dans la console
        console.log(`Envoi des résultats: ${totalElements} pistes au total`);
        console.log('Liste des pistes:', trackIds);

        const scrollIterations = Array.from({ length: 22 }); // Crée un tableau de 30 éléments
        for (const _ of scrollIterations) {
            await page.keyboard.press('ArrowUp');
            //await page.waitForTimeout(10); // Attendre un court instant pour le chargement
        }


        // Retourner la réponse au format attendu
        res.json({
            success: true,
            labels: labels,
            total: totalElements
        });
    } catch (error) {
        console.log(error.message);
        res.status(500).json({
            success: false,
            message: `Erreur lors de la récupération des labels: ${error.message}`
        });
    }
}));

// Route pour activer un label
app.get('/runLabel', ensurePageExists(async (req, res) => {
    const { label } = req.query;

    if (!label) {
        return res.status(400).json({
            success: false,
            message: "Label non spécifié"
        });
    }

    async function scrollToBottom(page) {
        try {
            await page.waitForLoadState('load', { timeout: 10000 });  // 10s max, état 'load'
            console.log("- Page chargée...");
        } catch (error) {
            console.log("- Erreur de chargement, on continue quand même :", error.message);
        }

        // Envoyer la touche ArrowDown 30 fois
        for (let i = 0; i < 22; i++) {
            await page.locator('.strips').focus().catch(() => page.locator('#app').focus());
            await page.keyboard.press('ArrowDown');
        }
    }

    // Exécuter le défilement
    await scrollToBottom(page);

    try {
        // Construire l'ID du premier slide du label
        const labelId = label.split('-slide')[0] + '-slide01';

        // Rechercher l'élément
        const element = await page.$(`#${labelId}`);

        if (!element) {
            return res.status(404).json({
                success: false,
                message: `L'élément #${labelId} n'est pas présent`
            });
        }

        // Faire défiler l'élément dans la vue et le sélectionner
        await element.scrollIntoViewIfNeeded();
        await element.focus();

        // Simuler des interactions de navigation
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(1000);
        await page.keyboard.press('ArrowLeft');

        res.json({
            success: true,
            message: "L'élément a été activé avec succès"
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: `Erreur lors de l'activation du label: ${error.message}`
        });
    }
}));

// Route pour récupérer les "strips"
app.get('/getStrips', ensurePageExists(async (req, res) => {
    try {
        // Rechercher tous les éléments de track splide
        const strips = await page.$('xpath=//div[contains(@id, "splide") and contains(@id, "-track")]');

        // Si aucun strip n'est trouvé
        if (strips.length === 0) {
            return res.json({
                success: true,
                nbstrips: 0,
                detail: []
            });
        }

        // Analyser chaque strip
        const stripDetails = await Promise.all(strips.map(async (strip, index) => {
            try {
                // Compter les éléments li visibles
                const visibleLiCount = await strip.$eval(
                    'li',
                    lis => lis.filter(li => li.classList.contains('is-visible')).length
                );

                // Compter le nombre total d'éléments li
                const liCount = await strip.$eval('li', lis => lis.length);

                // Récupérer l'ID du premier élément li visible
                const firstVisibleLiId = await strip.$eval(
                    'li.is-visible',
                    lis => lis.length > 0 ? lis[0].id : null
                );

                return {
                    stripNumber: index + 1,
                    liCount,
                    visibleCount: visibleLiCount,
                    firstVisibleId: firstVisibleLiId
                };
            } catch (err) {
                console.error(`Erreur lors de l'analyse du strip ${index + 1}:`, err);
                return {
                    stripNumber: index + 1,
                    error: err.message
                };
            }
        }));

        res.json({
            success: true,
            nbstrips: strips.length,
            detail: stripDetails
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: `Erreur lors de la récupération des strips: ${error.message}`
        });
    }
}));

// Route pour montrer un strip spécifique
app.get('/showStrip', ensurePageExists(async (req, res) => {
    const { numberstrip, selectedValue } = req.query;

    if (!numberstrip || !selectedValue) {
        return res.status(400).json({
            success: false,
            message: "Paramètres numberstrip et selectedValue requis"
        });
    }

    try {
        // Formater les numéros avec des zéros en préfixe si nécessaire
        const formattedStrip = String(numberstrip).padStart(2, '0');
        const formattedValue = String(selectedValue).padStart(2, '0');

        // Construire l'ID cible
        const targetId = `splide${formattedStrip}-slide${formattedValue}`;

        // Essayer de trouver directement l'élément
        const directElement = await page.$(`#${targetId}`);

        if (directElement) {
            // Si l'élément est trouvé directement, le faire défiler dans la vue et le mettre en évidence
            await directElement.scrollIntoViewIfNeeded();
            await directElement.focus();

            return res.json({
                success: true,
                method: "direct",
                message: `Élément ${targetId} activé avec succès`
            });
        }

        // Si l'élément n'est pas trouvé directement, essayer de naviguer par tabulation
        let focusedElementId = '';
        let attempts = 0;
        const maxAttempts = 50; // Limite de sécurité pour éviter une boucle infinie

        // Essayer de naviguer par tabulation jusqu'à trouver l'élément
        while (focusedElementId !== targetId && attempts < maxAttempts) {
            await page.keyboard.press('Tab');
            focusedElementId = await page.evaluate(() => document.activeElement.id);

            // Attendre un peu entre chaque tabulation
            await page.waitForTimeout(100);
            attempts++;
        }

        if (focusedElementId === targetId) {
            return res.json({
                success: true,
                method: "tabulation",
                attempts,
                message: `Strip ${formattedStrip} sélectionné à la valeur ${formattedValue}`
            });
        } else {
            return res.status(404).json({
                success: false,
                message: `Impossible de trouver ou sélectionner l'élément ${targetId} après ${attempts} tentatives`
            });
        }
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: `Erreur lors de l'affichage du strip: ${error.message}`
        });
    }
}));

// Route pour naviguer vers un menu du haut
app.get('/gotoMenuHaut', ensurePageExists(async (req, res) => {
    const { menu } = req.query;

    if (!menu) {
        return res.status(400).json({
            success: false,
            message: "Menu non spécifié"
        });
    }

    try {
        // Liste des menus disponibles
        //const menuDefini = ["Accueil", "TV en direct",  "Replay", "VOD", "Enregistrements", "Boutique TV"];
        const menuDefini = await getMenuHaut()
        console.log(menuDefini)
        const index = menuDefini.indexOf(menu);

        if (index === -1) {
            return res.status(400).json({
                success: false,
                message: `Menu "${menu}" non reconnu. Options disponibles: ${menuDefini.join(', ')}`
            });
        }

        // Obtenir la taille du viewport
        const viewport = await page.viewportSize();

        // Stratégie différente selon la largeur du viewport (responsive)
        if (viewport.width >= 1024) {
            // Version desktop : sélectionner directement l'élément du menu
            const menuSelector = `xpath=//*[@id="stvheader"]/header/div/div/div/nav/ul/li[${index + 1}]/a`;
            const element = await page.$(menuSelector);

            if (!element) {
                return res.status(404).json({
                    success: false,
                    message: `Menu "${menu}" non trouvé avec le sélecteur: ${menuSelector}`
                });
            }

            await element.click();

            // Attendre que la page se charge après le clic
            await page.waitForLoadState('domcontentloaded').catch(() => {
                console.log("La page ne s'est pas complètement chargée dans le délai imparti");
            });

            return res.json({
                success: true,
                menu,
                mode: "desktop"
            });
        } else {
            // Version mobile : ouvrir le menu burger puis sélectionner l'élément
            const burgerSelector = `xpath=//*[@id="stvheader"]/header/div/div/div/nav/ul/li[8]/button/span`;
            const burgerButton = await page.$(burgerSelector);

            if (!burgerButton) {
                return res.status(404).json({
                    success: false,
                    message: "Menu burger non trouvé avec le sélecteur: " + burgerSelector
                });
            }

            // Cliquer sur le bouton du menu burger
            await burgerButton.click();

            // Attendre que le menu s'ouvre
            await page.waitForTimeout(1000);

            // Sélectionner l'élément du sous-menu
            const submenuSelector = `xpath=//li[${index + 1}]/a/p[@class='stvui-bold-text itemized-title align-self-center body-1']`;
            const submenuButton = await page.$(submenuSelector);

            if (!submenuButton) {
                return res.status(404).json({
                    success: false,
                    message: `Sous-menu du menu "${menu}" non trouvé avec le sélecteur: ${submenuSelector}`
                });
            }

            await submenuButton.click();

            // Attendre que la page se charge après le clic
            await page.waitForLoadState('domcontentloaded').catch(() => {
                console.log("La page ne s'est pas complètement chargée dans le délai imparti");
            });

            return res.json({
                success: true,
                menu,
                mode: "mobile"
            });
        }
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: `Erreur lors de la navigation vers le menu: ${error.message}`
        });
    }
}));

// Route pour obtenir la position de défilement horizontale
app.get('/getX', ensurePageExists(async (req, res) => {
    try {
        const scrollPositionX = await page.evaluate(() => window.scrollX);
        res.json({ success: true, scroll_positionX: scrollPositionX });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: `Erreur lors de la récupération de la position X: ${error.message}`
        });
    }
}));

// Route pour obtenir la position de défilement verticale
app.get('/getY', ensurePageExists(async (req, res) => {
    try {
        const scrollPositionY = await page.evaluate(() => window.scrollY);
        res.json({ success: true, scroll_positionY: scrollPositionY });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: `Erreur lors de la récupération de la position Y: ${error.message}`
        });
    }
}));

// Route pour définir la position de défilement verticale
app.get('/setY', ensurePageExists(async (req, res) => {
    const { direction, y_position } = req.query;
    const yPosition = parseInt(y_position, 10);

    if (isNaN(yPosition)) {
        return res.status(400).json({
            success: false,
            message: "Position Y invalide"
        });
    }

    try {
        // Récupérer la position de défilement actuelle
        const currentScrollPosition = await page.evaluate(() => window.scrollY);
        let newScrollPosition = currentScrollPosition;

        // Calculer la nouvelle position en fonction de la direction
        if (direction === "ArrowDown") {
            newScrollPosition += yPosition;
        } else if (direction === "ArrowUp") {
            newScrollPosition -= yPosition;
        } else {
            newScrollPosition = yPosition; // Position absolue si aucune direction n'est spécifiée
        }

        // Appliquer le défilement
        await page.evaluate(
            scrollY => window.scrollTo({ top: scrollY, left: 0, behavior: 'auto' }),
            newScrollPosition
        );

        // Vérifier la nouvelle position
        const actualPosition = await page.evaluate(() => window.scrollY);

        res.json({
            success: true,
            previous: currentScrollPosition,
            requested: newScrollPosition,
            actual: actualPosition
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: `Erreur lors du défilement vertical: ${error.message}`
        });
    }
}));

// Route pour définir la position de défilement horizontale
app.get('/setX', ensurePageExists(async (req, res) => {
    const { x_position } = req.query;
    const xPosition = parseInt(x_position, 10);

    if (isNaN(xPosition)) {
        return res.status(400).json({
            success: false,
            message: "Position X invalide"
        });
    }

    try {
        // Récupérer la position de défilement actuelle
        const currentScrollPosition = await page.evaluate(() => window.scrollX);

        // Appliquer le défilement
        await page.evaluate(
            scrollX => window.scrollTo({ left: scrollX, top: window.scrollY, behavior: 'auto' }),
            xPosition
        );

        // Vérifier la nouvelle position
        const actualPosition = await page.evaluate(() => window.scrollX);

        res.json({
            success: true,
            previous: currentScrollPosition,
            requested: xPosition,
            actual: actualPosition
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: `Erreur lors du défilement horizontal: ${error.message}`
        });
    }
}));

// Route pour obtenir la hauteur de la fenêtre
app.get('/getWindowY', ensurePageExists(async (req, res) => {
    try {
        const windowHeight = await page.evaluate(() => window.innerHeight);
        res.json({ success: true, size: windowHeight });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: `Erreur lors de la récupération de la hauteur de fenêtre: ${error.message}`
        });
    }
}));

// Route pour obtenir les dimensions de la fenêtre
app.get('/getWindowSize', ensurePageExists(async (req, res) => {
    try {
        const viewportSize = await page.viewportSize();
        res.json({ success: true, size: viewportSize });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: `Erreur lors de la récupération des dimensions de la fenêtre: ${error.message}`
        });
    }
}));

// Route pour fermer le navigateur
app.get('/setClose', async (req, res) => {
    if (!browserLaunch) {
        return res.json({
            success: true,
            message: "Aucun navigateur n'est actif"
        });
    }

    try {
        // Arrêter le traçage si le mode debug est activé
        if (debugBrowser && context) {
            try {
                await context.tracing.stop({
                    path: path.join(TRACES_DIR, 'trace.zip')
                });
            } catch (traceError) {
                console.error("Erreur lors de l'arrêt du traçage:", traceError.message);
            }
        }

        // Fermer le navigateur
        await browserLaunch.close();

        // Réinitialiser les variables
        browserLaunch = null;
        page = null;
        context = null;
        setVideo = false;
        isRunning = false;

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: `Erreur lors de la fermeture du navigateur: ${error.message}`
        });
    }
});

// Route pour arrêter le débogage
app.get('/setCloseDebug', ensurePageExists(async (req, res) => {
    try {
        if (debugBrowser && context) {
            try {
                await context.tracing.stop({
                    path: path.join(TRACES_DIR, 'trace.zip')
                });
            } catch (traceError) {
                console.error("Erreur lors de l'arrêt du traçage:", traceError.message);
            }
        }

        // Désactiver le mode vidéo
        setVideo = false;
        debugBrowser = false;

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: `Erreur lors de la fermeture du débogage: ${error.message}`
        });
    }
}));

// Route de vérification de la disponibilité du serveur
app.get('/ping', (req, res) => {
    res.json({
        success: true,
        response: 'pong',
        timestamp: Date.now(),
        version: VERSION
    });
});

// Route pour récupérer les cookies
app.get('/get_cookies', ensurePageExists(async (req, res) => {
    const { compte } = req.query;

    try {
        // Récupérer tous les cookies
        const cookies = await context.cookies();

        if (cookies.length === 0) {
            return res.json({
                success: true,
                message: "Aucun cookie trouvé",
                count: 0
            });
        }

        // Déterminer le chemin du fichier de cookies
        const cookiePath = compte
            ? path.join(COOKIES_DIR, `${compte.replace('@', '_')}.json`)
            : path.join(COOKIES_DIR, 'cookies.json');

        // Écrire les cookies dans un fichier
        await fsPromises.writeFile(cookiePath, JSON.stringify(cookies, null, 2));

        res.json({
            success: true,
            message: "Cookies sauvegardés avec succès",
            path: cookiePath,
            count: cookies.length
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: `Erreur lors de la récupération des cookies: ${error.message}`
        });
    }
}));

// Route pour récupérer la version du serveur
app.get('/getVersion', (req, res) => {
    res.json({
        success: true,
        version: VERSION,
        os: os.platform(),
        message: `Version: ${VERSION}`
    });
});

// Route pour lister toutes les routes disponibles
app.get('/routes', (req, res) => {
    const routes = listEndpoints(app).map(endpoint => ({
        path: endpoint.path,
        methods: endpoint.methods
    }));

    res.status(200).json({
        success: true,
        count: routes.length,
        routes
    });
});

// Route pour télécharger toutes les vidéos
app.get('/download-all-videos', async (req, res) => {
    try {
        console.log('Préparation du téléchargement des vidéos...');

        // Arrêter le traçage si le navigateur est actif
        if (browserLaunch && context && debugBrowser) {
            try {
                await context.tracing.stop({
                    path: path.join(VIDEOS_DIR, 'trace.zip')
                });
            } catch (traceError) {
                console.error("Erreur lors de l'arrêt du traçage:", traceError.message);
            }
        }

        // Fermer le navigateur si nécessaire
        if (browserLaunch) {
            await browserLaunch.close();
            browserLaunch = null;
            page = null;
            context = null;
            isRunning = false;
        }

        setVideo = false;
        debugBrowser = false;

        // Vérifier si des fichiers existent dans le dossier des vidéos
        const files = await fsPromises.readdir(VIDEOS_DIR);

        if (files.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Aucun fichier vidéo ou trace trouvé"
            });
        }

        // Créer une archive ZIP
        const zip = new JSZip();

        // Ajouter tous les fichiers à l'archive
        await Promise.all(files.map(async file => {
            const filePath = path.join(VIDEOS_DIR, file);
            const fileData = await fsPromises.readFile(filePath);
            zip.file(file, fileData);
        }));

        // Générer le contenu ZIP
        const zipContent = await zip.generateAsync({ type: 'nodebuffer' });

        // Définir les en-têtes pour le téléchargement
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename=videos.zip');
        res.setHeader('Content-Length', zipContent.length);

        // Envoyer l'archive
        res.send(zipContent);
    } catch (err) {
        console.error("Erreur lors de la création de l'archive ZIP:", err);
        res.status(500).json({
            success: false,
            message: `Erreur lors de la création de l'archive ZIP: ${err.message}`
        });
    }
});

// Route pour télécharger trace.zip
app.get('/download/trace', (req, res) => {
    const tracePath = path.join(TRACES_DIR, 'trace.zip');

    // Vérifier si le fichier existe
    if (!fs.existsSync(tracePath)) {
        return res.status(404).json({
            success: false,
            message: 'Le fichier trace.zip n\'a pas été trouvé'
        });
    }

    try {
        // Définir les en-têtes pour le téléchargement
        res.setHeader('Content-Disposition', 'attachment; filename=trace.zip');
        res.setHeader('Content-Type', 'application/zip');

        // Envoyer le fichier
        const fileStream = fs.createReadStream(tracePath);
        fileStream.pipe(res);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: `Erreur lors du téléchargement du fichier: ${error.message}`
        });
    }
});


async function getMenuHaut() {
    // Attendre que les éléments de menu soient chargés
    await page.waitForSelector('.menu-item');

    // Extraire les éléments de menu
    const menuItems = await page.evaluate(() => {
        const items = document.querySelectorAll('.menu-item');
        return Array.from(items)
            .filter(item => item.querySelector('.stvui-bold-text')) // Optionnel : filtrer les éléments valides
            .map(item => {
                const textElement = item.querySelector('.stvui-bold-text');
                const linkElement = item.querySelector('a');

                return {
                    text: textElement.textContent.trim(),
                    link: linkElement.getAttribute('href')
                };
            });
    });

    const textArray = menuItems.map(item => item.text);

    return textArray;
}

// Route pour faire une mise à jour du code
app.get('/pull', (req, res) => {
    const projectPath = '/home/ivatests/Documents/playwrightServer1';

    // Vérifier si Git est disponible
    exec('git --version', (versionError) => {
        if (versionError) {
            console.error('Git n\'est pas installé ou inaccessible');
            return res.status(500).json({
                success: false,
                message: 'Git n\'est pas installé ou inaccessible dans le PATH'
            });
        }

        // Exécuter le git pull
        exec('git pull --rebase origin main', { cwd: projectPath }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Erreur lors du git pull: ${error.message}`);
                return res.status(500).json({
                    success: false,
                    message: `Erreur lors de la mise à jour du code: ${error.message}`,
                    details: stderr
                });
            }

            console.log(`Résultat du pull: ${stdout}`);
            res.json({
                success: true,
                message: 'Code mis à jour avec succès',
                output: stdout
            });
        });
    });
});

// Route pour aller en arrière
app.get('/setNavBackBrowser', ensurePageExists(async (req, res) => {
    try {
        const navigation = await page.goBack({ timeout: 5000 });

        const currentUrl = await page.url();
        res.json({
            success: true,
            message: "Retour en arrière effectué",
            currentUrl
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Erreur lors du retour en arrière",
            error: error.message
        });
    }
}));

// Route pour aller en avant
app.get('/setNavForwardBrowser', ensurePageExists(async (req, res) => {
    try {
        const navigation = await page.goForward({ timeout: 5000 });

        const currentUrl = await page.url();
        res.json({
            success: true,
            message: "Avancement effectué",
            currentUrl
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Erreur lors de l'avancement",
            error: error.message
        });
    }
}));

// Route pour rafraîchir la page
app.get('/setNavRefreshBrowser', ensurePageExists(async (req, res) => {
    try {
        networkResponses = []
        await page.reload({ timeout: 5000 });

        const currentUrl = await page.url();
        res.json({
            success: true,
            message: "Page rafraîchie avec succès",
            currentUrl
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Erreur lors du rafraîchissement",
            error: error.message
        });
    }
}));

// Route pour le consentement
app.get('/setConsentement', ensurePageExists(async (req, res) => {
    try {
        // Convertir statusConsentement en booléen
        const statusConsentement = req.query.statusConsentement === 'True';

        console.log(`Changement de consentement demandé: ${statusConsentement}`);

        // Vérifier l'état actuel
        const currentStatus = await page.textContent('#bulk-action-button .didomi-button-status');
        // Cliquer si l'état actuel ne correspond pas à l'état désiré
        const shouldClick = (statusConsentement && currentStatus !== 'Activé') ||
            (!statusConsentement && currentStatus !== 'Désactivé');

        console.log(`État actuel: ${currentStatus}, devrait cliquer: ${shouldClick}`);

        if (shouldClick) {
            await page.click('#bulk-action-button');
        }

        const buttonText = statusConsentement ? 'Activé' : 'Désactivé';

        res.json({
            success: true,
            message: `Consentement ${buttonText.toLowerCase()} avec succès`
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Erreur lors de la modification du consentement",
            error: error.message
        });
    }
}));


async function typeTextOnKeyboard(page, textToType, clearFirst = true) {

    // Optionnel : Effacez tout d'abord
    if (clearFirst) {
        const clearButton = page.locator('button[aria-label="Tout effacer"]');
        await clearButton.click();
        await page.waitForTimeout(200);
    }

    // Mapping pour caractères spéciaux (ajoutez-en si besoin)
    const specialKeys = {
        ' ': 'espace',
        "'": 'apostrophe',
        '-': 'tiret',
        // Backspace : utilisez-le manuellement si besoin, ex. pour corriger
    };

    // Saisir chaque caractère
    for (const char of textToType.toUpperCase()) { // Majuscules pour matcher le clavier
        let keySelector;
        if (specialKeys[char]) {
            keySelector = `[aria-label="${specialKeys[char]}"]`;
        } else if (/[A-Z0-9]/.test(char)) {
            keySelector = `button.kb-key[aria-label="${char}"]`;
        } else {
            console.warn(`Caractère non supporté : ${char}. Ignoré.`);
            continue;
        }

        // Attendre et cliquer
        await page.waitForSelector(keySelector, { timeout: 2000 });
        const keyButton = page.locator(keySelector);
        await keyButton.click();
        await page.waitForTimeout(150); // Délai pour fluidité
    }

    // Optionnel : Backspace pour corriger (ex. : 2 fois)
    // const backspace = page.locator('[aria-label="supprimer"]');
    // await backspace.click();
    // await backspace.click();
}
