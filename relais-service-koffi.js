// relais-service-koffi.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const koffi = require('koffi');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname)); // Pour servir les fichiers HTML

// Configuration
const CONFIG = {
    ttlockApi:     process.env.TTLOCK_API      || 'https://euapi.ttlock.com/v3',
    clientId:      process.env.CLIENT_ID       || 'c38e2073f5f24f9b9ec7b986739071be',
    clientSecret:  process.env.CLIENT_SECRET   || '56477c7443d81c7f049d9d0cf29649bc',
    // Compte hôtel TTHotel pour OAuth (active le mode TTHotel)
    hotelUsername: process.env.HOTEL_USERNAME  || 'h_1771838510017',
    hotelPassword: process.env.HOTEL_PASSWORD  || 'ed1e90da0b8f1d4a9cb158843c34d114', // MD5
    oauthUrl:      'https://euapi.sciener.com/oauth2/token',
    accessToken:   null,
    tokenExpiry:   null,
    comPort:       process.env.COM_PORT        || 'COM9',
    currentHotelInfo: null,
    hotelInfoExpiry:  null,
    pendingRequests:  new Map()
};

// Fonction utilitaire pour le fuseau horaire
function getTimezoneOffset() {
    const date = new Date();
    const isDST = date.getMonth() > 2 && date.getMonth() < 10;
    return isDST ? 7200 : 3600; // GMT+2 = 7200s, GMT+1 = 3600s
}

// Gestion des erreurs
const ENCODER_ERROR_HINTS = {
    106: 'Carte non détectée, non compatible ou non préparée. Repositionnez la carte, puis essayez "Initialiser la carte" avant lecture/écriture.',
    1: 'Échec de connexion à l\'encodeur. Vérifiez le câble USB et le port COM.',
    2: 'Paramètre invalide. Vérifiez les données envoyées.',
    3: 'Erreur de communication (écriture). Vérifiez la connexion.',
    4: 'Erreur de communication (lecture). Vérifiez la connexion.',
    5: 'Erreur de commande. L\'encodeur a retourné une erreur.',
    13: 'HotelInfo expiré ou invalide. Rafraîchissez hotelInfo.',
    201: 'Échec de configuration de la clé.',
    202: 'Échec de configuration de la clé carte.',
    203: 'Échec de configuration des informations hôtel.'
};

function parseEncoderErrorCode(message) {
    const match = /\(code:\s*(-?\d+)\)/.exec(message || '');
    return match ? Number(match[1]) : null;
}

function withEncoderHint(message) {
    const code = parseEncoderErrorCode(message);
    if (code === null) return message;

    const hint = ENCODER_ERROR_HINTS[code];
    if (!hint) return message;
    if ((message || '').includes(hint)) return message;

    return `${message} — ${hint}`;
}

// Charger la DLL avec koffi
console.log('Chargement de CardEncoder.dll...');
const lib = koffi.load('./CardEncoder.dll');

// Déclaration des fonctions de la DLL (syntaxe koffi correcte)
const CE_ConnectComm = lib.func('CE_ConnectComm', 'int', ['string']);
const CE_DisconnectComm = lib.func('CE_DisconnectComm', 'int', []);
const CE_InitCardEncoder = lib.func('CE_InitCardEncoder', 'int', ['string']);
const CE_InitCard = lib.func('CE_InitCard', 'int', ['string']);
const CE_WriteCard = lib.func('CE_WriteCard', 'int', ['string', 'int', 'int', 'string', 'int64', 'bool']);
const CE_ReadCard = lib.func('CE_ReadCard', 'int', ['string', 'void *']);
const CE_GetCardNo = lib.func('CE_GetCardNo', 'int', ['void *']);
const CE_ClearCard = lib.func('CE_ClearCard', 'int', ['string']);
const CE_Beep = lib.func('CE_Beep', 'int', ['int', 'int', 'int']);
const CE_GetVersion = lib.func('CE_GetVersion', 'int', ['void *']);

// Version V2 avec support timeMark (si disponible dans la DLL)
// Si cette fonction n'existe pas, la déclaration échouera silencieusement
let CE_WriteCard_V2 = null;
try {
    CE_WriteCard_V2 = lib.func('CE_WriteCard_V2', 'int', [
        'string',   // hotelInfo
        'uchar',    // timeMark
        'int',      // buildingNo
        'int',      // floorNo
        'string',   // mac
        'int64',    // startDate
        'int64',    // endDate
        'bool',     // allowLockOut
        'int',      // timezoneRawOffset
        'bool',     // isCycle
        'uchar',    // cycleType
        'int',      // cycleCount
        'void *',   // cycleDays
        'uint',     // startTime
        'uint'      // endTime
    ]);
    console.log('✓ Fonction CE_WriteCard_V2 détectée (mode strict disponible)');
} catch (e) {
    console.log('⚠️ Fonction CE_WriteCard_V2 non disponible, utilisation du mode standard');
}

console.log('✓ DLL chargée avec succès');

// Service de gestion hotelInfo
class HotelInfoManager {

    // Obtenir un access_token OAuth (mode TTHotel uniquement)
    async getAccessToken() {
        if (CONFIG.accessToken && CONFIG.tokenExpiry && Date.now() < CONFIG.tokenExpiry) {
            return CONFIG.accessToken;
        }

        console.log('Authentification TTHotel (OAuth)...');
        const params = new URLSearchParams({
            clientId:     CONFIG.clientId,
            clientSecret: CONFIG.clientSecret,
            username:     CONFIG.hotelUsername,
            password:     CONFIG.hotelPassword,
        });

        const response = await axios.post(CONFIG.oauthUrl, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        if (!response.data.access_token) {
            throw new Error(`OAuth échoué : ${JSON.stringify(response.data)}`);
        }

        CONFIG.accessToken = response.data.access_token;
        // expires_in en secondes, on garde 5 min de marge
        CONFIG.tokenExpiry = Date.now() + ((response.data.expires_in || 7776000) - 300) * 1000;
        console.log('✓ Access token TTHotel obtenu');
        return CONFIG.accessToken;
    }

    async refreshHotelInfo() {
        try {
            const timestamp = Date.now();
            const url = `${CONFIG.ttlockApi}/hotel/getInfo`;
            console.log(`Récupération hotelInfo depuis ${url}...`);

            // hotel/getInfo utilise toujours clientId + clientSecret (pas d'accessToken)
            // L'OAuth sert uniquement pour les autres endpoints TTHotel cloud
            if (CONFIG.hotelUsername && CONFIG.hotelPassword) {
                await this.getAccessToken(); // pré-chauffer le token pour usage ultérieur
            }
            const params = { clientId: CONFIG.clientId, clientSecret: CONFIG.clientSecret, date: timestamp };

            const response = await axios.get(url, { params });

            if (response.data.errcode === 0 || response.data.hotelInfo) {
                CONFIG.currentHotelInfo = response.data.hotelInfo;
                CONFIG.hotelInfoExpiry = Date.now() + 10 * 60 * 1000;
                console.log('✓ hotelInfo récupéré avec succès');
                return CONFIG.currentHotelInfo;
            } else {
                throw new Error(`Erreur API: ${response.data.errmsg || JSON.stringify(response.data)}`);
            }
        } catch (error) {
            console.error('✗ Erreur récupération hotelInfo:', error.message);
            throw error;
        }
    }

    async getValidHotelInfo() {
        if (!CONFIG.currentHotelInfo || Date.now() > CONFIG.hotelInfoExpiry - 60000) {
            console.log('hotelInfo expiré ou bientôt expiré, rafraîchissement...');
            return await this.refreshHotelInfo();
        }
        return CONFIG.currentHotelInfo;
    }
}

const hotelInfoManager = new HotelInfoManager();

// Service de gestion de l'encodeur
class EncoderService {
    async retryCardOperation(operationName, operationFn, maxAttempts = 3, retryDelayMs = 700) {
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await operationFn();
            } catch (error) {
                lastError = error;
                const code = parseEncoderErrorCode(error.message);
                const shouldRetry = code === 106 && attempt < maxAttempts;

                if (!shouldRetry) {
                    throw new Error(withEncoderHint(error.message));
                }

                console.warn(`⚠️ ${operationName} - tentative ${attempt}/${maxAttempts} échouée (code 106), nouvelle tentative...`);
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            }
        }

        throw new Error(withEncoderHint(lastError?.message || `${operationName} échoué`));
    }

    async connect() {
        console.log(`Connexion à l'encodeur sur ${CONFIG.comPort}...`);
        const result = CE_ConnectComm(CONFIG.comPort);

        if (result !== 0) {
            throw new Error(`Échec connexion encodeur (code: ${result})`);
        }

        console.log('✓ Connecté à l\'encodeur');
        return true;
    }

    disconnect() {
        try {
            CE_DisconnectComm();
            console.log('Déconnecté de l\'encodeur');
        } catch (e) {
            // Ignorer les erreurs de déconnexion
        }
    }

    async initializeEncoder(hotelInfo) {
        console.log('Initialisation de l\'encodeur...');
        const result = CE_InitCardEncoder(hotelInfo);

        if (result !== 0) {
            throw new Error(`Échec initialisation encodeur (code: ${result})`);
        }

        console.log('✓ Encodeur initialisé');
        return true;
    }

    async initCard(hotelInfo) {
        console.log('Initialisation de la carte...');
        const result = CE_InitCard(hotelInfo);

        if (result !== 0) {
            throw new Error(`Échec initialisation carte (code: ${result})`);
        }

        console.log('✓ Carte initialisée avec succès');
        return true;
    }

    async writeCard(hotelInfo, cardData) {
        console.log(`Écriture carte pour chambre ${cardData.roomNumber}...`);

        const startTimestamp = cardData.startTimestamp || Math.floor(Date.now() / 1000);
        const expiryTimestamp = cardData.expiryTimestamp || 0;

        // Si la fonction V2 est disponible, utiliser le mode strict
        if (CE_WriteCard_V2) {
            const timeMark = 0; // 0 = Enforcement strict
            const timezoneRawOffset = getTimezoneOffset();

            console.log(`   Période de validité: ${new Date(startTimestamp * 1000).toLocaleString()} → ${new Date(expiryTimestamp * 1000).toLocaleString()}`);
            console.log(`   Mode: STRICT (timeMark=0, timezone=${timezoneRawOffset}s)`);

            await this.retryCardOperation('Écriture carte', async () => {
                const result = CE_WriteCard_V2(
                    hotelInfo,
                    timeMark,
                    cardData.buildingNo || 0,
                    cardData.floorNo || 0,
                    cardData.mac || '000000000000',
                    BigInt(startTimestamp),
                    BigInt(expiryTimestamp),
                    cardData.allowLockOut || false,
                    timezoneRawOffset,
                    false,  // isCycle
                    0,      // cycleType
                    0,      // cycleCount
                    null,   // cycleDays
                    0,      // startTime
                    0       // endTime
                );

                if (result !== 0) {
                    throw new Error(`Échec écriture carte (code: ${result})`);
                }
            });

            console.log('✓ Carte écrite avec succès (mode strict - enforcement)');
        } else {
            // Mode standard sans timeMark
            console.log(`   Date d'expiration: ${new Date(expiryTimestamp * 1000).toLocaleString()}`);
            console.log(`   Mode: STANDARD (expiration non stricte)`);

            await this.retryCardOperation('Écriture carte', async () => {
                const result = CE_WriteCard(
                    hotelInfo,
                    cardData.buildingNo || 0,
                    cardData.floorNo || 0,
                    cardData.mac || '000000000000',
                    BigInt(expiryTimestamp),
                    cardData.allowLockOut || false
                );

                if (result !== 0) {
                    throw new Error(`Échec écriture carte (code: ${result})`);
                }
            });

            console.log('✓ Carte écrite avec succès (mode standard)');
        }

        this.beep(200, 100, 2);
        return true;
    }

    async readCard(hotelInfo) {
        console.log('Lecture de la carte...');
        const buffer = Buffer.alloc(4096);
        await this.retryCardOperation('Lecture carte', async () => {
            const result = CE_ReadCard(hotelInfo, buffer);

            if (result !== 0) {
                throw new Error(`Échec lecture carte (code: ${result})`);
            }
        });

        const dataStr = buffer.toString('utf8').replace(/\0/g, '');
        console.log('✓ Carte lue');

        try {
            return JSON.parse(dataStr);
        } catch (e) {
            return { raw: dataStr };
        }
    }

    async getCardNumber() {
        const buffer = Buffer.alloc(256);
        const result = CE_GetCardNo(buffer);

        if (result !== 0) {
            throw new Error(withEncoderHint(`Échec récupération numéro carte (code: ${result})`));
        }

        const utf8Value = buffer.toString('utf8').replace(/\0/g, '').trim();
        const isPrintable = utf8Value.length > 0 && /^[\x20-\x7E]+$/.test(utf8Value);
        if (isPrintable) return utf8Value;

        if (buffer.length >= 4) {
            return buffer.readUInt32LE(0).toString();
        }

        return 'Numéro non lisible';
    }

    async clearCard(hotelInfo) {
        console.log('Effacement de la carte...');
        await this.retryCardOperation('Effacement carte', async () => {
            const result = CE_ClearCard(hotelInfo);

            if (result !== 0) {
                throw new Error(`Échec effacement carte (code: ${result})`);
            }
        });

        console.log('✓ Carte effacée avec succès');
        return true;
    }

    beep(len, interval, count) {
        try {
            CE_Beep(len, interval, count);
        } catch (e) {
            // Ignorer
        }
    }

    async getVersion() {
        const buffer = Buffer.alloc(1024);
        const result = CE_GetVersion(buffer);

        if (result !== 0) {
            return { error: 'Impossible de récupérer la version' };
        }

        try {
            const versionStr = buffer.toString('utf8').replace(/\0/g, '');
            return JSON.parse(versionStr);
        } catch (e) {
            return { version: buffer.toString('utf8').replace(/\0/g, '') };
        }
    }
}

const encoderService = new EncoderService();

// ==================== ROUTES API ====================

// Route racine
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Service Encodeur TTlock</title></head>
            <body style="font-family:Arial;max-width:800px;margin:auto;padding:20px">
                <h1>✅ Service Encodeur TTlock actif</h1>
                <p>Le service tourne sur le port ${PORT}</p>
                <h2>Routes disponibles :</h2>
                <ul>
                    <li><a href="/api/status">GET /api/status</a> - État du service</li>
                    <li>POST /api/read-card - Lire une carte</li>
                    <li>POST /api/encode-card - Encoder une carte</li>
                    <li>POST /api/get-card-number - Obtenir numéro carte</li>
                    <li>POST /api/clear-card - Effacer carte</li>
                    <li>POST /api/init-card - Initialiser carte</li>
                    <li>POST /api/refresh-hotel-info - Rafraîchir hotelInfo</li>
                </ul>
                <p><a href="/encoder-web.html">Accéder à l'interface web</a></p>
            </body>
        </html>
    `);
});

// GET /api/status
app.get('/api/status', async (req, res) => {
    try {
        let version = { error: 'Non disponible' };
        try {
            version = await encoderService.getVersion();
        } catch (e) {
            // Ignorer
        }

        res.json({
            status: 'online',
            encoderConnected: true,
            hotelInfo: {
                present: !!CONFIG.currentHotelInfo,
                expiry: CONFIG.hotelInfoExpiry ? new Date(CONFIG.hotelInfoExpiry).toLocaleString() : 'N/A'
            },
            version: version,
            pendingRequests: CONFIG.pendingRequests.size,
            strictMode: CE_WriteCard_V2 !== null
        });
    } catch (error) {
        res.json({
            status: 'online',
            encoderConnected: false,
            error: error.message
        });
    }
});

// POST /api/encode-card
app.post('/api/encode-card', async (req, res) => {
    const requestId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const { roomNumber, mac, startDate, expiryDate, buildingNo = 1, floorNo } = req.body;

    if (!roomNumber) {
        return res.status(400).json({ error: 'roomNumber requis' });
    }

    // Calculer les timestamps
    let startTimestamp = Math.floor(Date.now() / 1000);
    if (startDate) {
        startTimestamp = Math.floor(new Date(startDate).getTime() / 1000);
    }

    let expiryTimestamp = 0;
    if (expiryDate) {
        expiryTimestamp = Math.floor(new Date(expiryDate).getTime() / 1000);
    }

    if (!expiryTimestamp) {
        return res.status(400).json({ error: 'expiryDate requis' });
    }

    CONFIG.pendingRequests.set(requestId, {
        id: requestId,
        roomNumber,
        mac: mac || '000000000000',
        buildingNo,
        floorNo: floorNo || roomNumber,
        startTimestamp: startTimestamp,
        expiryTimestamp: expiryTimestamp,
        allowLockOut: true,
        status: 'pending',
        createdAt: new Date()
    });

    console.log(`📝 Demande d'encodage reçue: Chambre ${roomNumber} (ID: ${requestId})`);
    console.log(`   Validité: ${new Date(startTimestamp * 1000).toLocaleString()} → ${new Date(expiryTimestamp * 1000).toLocaleString()}`);
    console.log(`   Mode: ${CE_WriteCard_V2 ? 'STRICT (timeMark=0)' : 'STANDARD'}`);

    res.json({
        success: true,
        requestId,
        message: 'Demande d\'encodage en attente',
        instructions: 'Placez la carte sur l\'encodeur'
    });

    processEncodingRequest(requestId).catch(console.error);
});

// GET /api/status/:requestId
app.get('/api/status/:requestId', (req, res) => {
    const request = CONFIG.pendingRequests.get(req.params.requestId);

    if (!request) {
        return res.status(404).json({ error: 'Requête non trouvée' });
    }

    res.json(request);
});

// POST /api/read-card
app.post('/api/read-card', async (req, res) => {
    try {
        const hotelInfo = await hotelInfoManager.getValidHotelInfo();

        await encoderService.connect();
        await encoderService.initializeEncoder(hotelInfo);

        const cardData = await encoderService.readCard(hotelInfo);

        encoderService.disconnect();

        res.json({
            success: true,
            cardData
        });
    } catch (error) {
        encoderService.disconnect();
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// POST /api/clear-card
app.post('/api/clear-card', async (req, res) => {
    try {
        const hotelInfo = await hotelInfoManager.getValidHotelInfo();

        await encoderService.connect();
        await encoderService.initializeEncoder(hotelInfo);

        await encoderService.clearCard(hotelInfo);

        encoderService.disconnect();

        res.json({
            success: true,
            message: 'Carte effacée avec succès'
        });
    } catch (error) {
        encoderService.disconnect();
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// POST /api/init-card
app.post('/api/init-card', async (req, res) => {
    try {
        const hotelInfo = await hotelInfoManager.getValidHotelInfo();

        await encoderService.connect();
        await encoderService.initializeEncoder(hotelInfo);

        await encoderService.initCard(hotelInfo);

        encoderService.disconnect();

        res.json({
            success: true,
            message: 'Carte initialisée avec succès'
        });
    } catch (error) {
        encoderService.disconnect();
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// POST /api/get-card-number
app.post('/api/get-card-number', async (req, res) => {
    try {
        const hotelInfo = await hotelInfoManager.getValidHotelInfo();
        await encoderService.connect();
        await encoderService.initializeEncoder(hotelInfo);
        const cardNumber = await encoderService.getCardNumber();
        encoderService.disconnect();

        res.json({
            success: true,
            cardNumber
        });
    } catch (error) {
        encoderService.disconnect();
        res.status(500).json({
            success: false,
            error: withEncoderHint(error.message)
        });
    }
});

// POST /api/refresh-hotel-info
app.post('/api/refresh-hotel-info', async (req, res) => {
    try {
        const hotelInfo = await hotelInfoManager.refreshHotelInfo();
        res.json({
            success: true,
            hotelInfo: hotelInfo.substring(0, 20) + '...'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Traitement des demandes d'encodage
async function processEncodingRequest(requestId) {
    const request = CONFIG.pendingRequests.get(requestId);
    if (!request) return;

    try {
        request.status = 'processing';

        const hotelInfo = await hotelInfoManager.getValidHotelInfo();

        await encoderService.connect();
        await encoderService.initializeEncoder(hotelInfo);

        // CE_InitCard optionnel : sauté si hotelInfo TTHotel (code 106 sinon)
        if (!CONFIG.hotelUsername) {
            await encoderService.initCard(hotelInfo);
        }

        await encoderService.writeCard(hotelInfo, {
            roomNumber: request.roomNumber,
            mac: request.mac,
            buildingNo: request.buildingNo,
            floorNo: request.floorNo,
            startTimestamp: request.startTimestamp,
            expiryTimestamp: request.expiryTimestamp,
            allowLockOut: request.allowLockOut
        });

        const cardData = await encoderService.readCard(hotelInfo);

        // Lire le numéro de série physique de la carte (CE_GetCardNo)
        let cardNo = null;
        try {
            cardNo = await encoderService.getCardNumber();
            console.log(`✓ Numéro de carte (UID): ${cardNo}`);
        } catch (e) {
            console.warn(`⚠️ Lecture numéro carte échouée: ${e.message}`);
        }

        encoderService.disconnect();

        request.status = 'success';
        request.completedAt = new Date();
        request.cardData = cardData;
        request.cardNo = cardNo;

        console.log(`✅ Encodage réussi pour chambre ${request.roomNumber}`);

    } catch (error) {
        encoderService.disconnect();

        request.status = 'error';
        request.error = error.message;
        request.completedAt = new Date();

        console.error(`❌ Échec encodage pour chambre ${request.roomNumber}:`, error.message);
    }

    setTimeout(() => {
        CONFIG.pendingRequests.delete(requestId);
    }, 60 * 60 * 1000);
}

// Rafraîchissement automatique toutes les 9 minutes
setInterval(async () => {
    try {
        await hotelInfoManager.refreshHotelInfo();
    } catch (error) {
        console.error('Échec rafraîchissement automatique:', error.message);
    }
}, 9 * 60 * 1000);

// Démarrer le serveur
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║     Service Relais TTlock Encodeur (Koffi)              ║
╠══════════════════════════════════════════════════════════╣
║  • URL: http://localhost:${PORT}                          ║
║  • Port COM: ${CONFIG.comPort}                                   ║
║  • Mode strict: ${CE_WriteCard_V2 ? 'ACTIVÉ ✓' : 'DÉSACTIVÉ (V2 non disponible)'} ║
╚══════════════════════════════════════════════════════════╝
    `);

    // Test rapide
    setTimeout(async () => {
        try {
            await encoderService.connect();
            console.log('✓ Encodeur détecté');

            const version = await encoderService.getVersion();
            console.log('✓ Version:', version);

            encoderService.disconnect();
        } catch (error) {
            console.warn('⚠️ Encodeur non détecté:', error.message);
            console.warn('   Vérifiez:');
            console.warn('   - L\'encodeur est branché en USB');
            console.warn(`   - Le port ${CONFIG.comPort} est correct`);
            console.warn('   - Les drivers sont installés');
        }
    }, 2000);
});

// Gestion arrêt
process.on('SIGINT', () => {
    console.log('\nArrêt du service...');
    encoderService.disconnect();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\nArrêt du service...');
    encoderService.disconnect();
    process.exit(0);
});