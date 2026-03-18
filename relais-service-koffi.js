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

// Configuration
const CONFIG = {
    ttlockApi: process.env.TTLOCK_API || 'https://euapi.ttlock.com/v3',
    clientId: process.env.CLIENT_ID || '5e53c28e38d94c0d99d0f83fe9e9fe3a',
    clientSecret: process.env.CLIENT_SECRET || 'd441734ad779dfea59d09663127bfd46',
    comPort: process.env.COM_PORT || 'COM3',
    currentHotelInfo: null,
    hotelInfoExpiry: null,
    pendingRequests: new Map()
};

// Charger la DLL avec koffi
console.log('Chargement de CardEncoder.dll...');
const lib = koffi.load('./CardEncoder.dll');

// Définir les fonctions de la DLL avec des chaînes de caractères pour les types
const CE_ConnectComm = lib.func('CE_ConnectComm', 'int', ['string']);
const CE_DisconnectComm = lib.func('CE_DisconnectComm', 'int', []);
const CE_InitCardEncoder = lib.func('CE_InitCardEncoder', 'int', ['string']);
const CE_WriteCard = lib.func('CE_WriteCard', 'int', ['string', 'int', 'int', 'string', 'uint64', 'bool']);
const CE_ReadCard = lib.func('CE_ReadCard', 'int', ['string', 'pointer']);
const CE_GetCardNo = lib.func('CE_GetCardNo', 'int', ['pointer']);
const CE_Beep = lib.func('CE_Beep', 'int', ['int', 'int', 'int']);
const CE_GetVersion = lib.func('CE_GetVersion', 'int', ['pointer']);
const CE_ClearCard = lib.func('CE_ClearCard', 'int', ['string']);

console.log('✓ DLL chargée avec succès');

// Service de gestion hotelInfo
class HotelInfoManager {
    async refreshHotelInfo() {
        try {
            const timestamp = Date.now();
            const url = `${CONFIG.ttlockApi}/hotel/getInfo`;

            console.log(`Récupération hotelInfo depuis ${url}...`);

            const response = await axios.get(url, {
                params: {
                    clientId: CONFIG.clientId,
                    clientSecret: CONFIG.clientSecret,
                    date: timestamp
                }
            });

            if (response.data.errcode === 0 || response.data.hotelInfo) {
                CONFIG.currentHotelInfo = response.data.hotelInfo;
                CONFIG.hotelInfoExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes
                console.log('✓ hotelInfo récupéré avec succès');
                return CONFIG.currentHotelInfo;
            } else {
                throw new Error(`Erreur API: ${response.data.errmsg || 'Inconnue'}`);
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

    async writeCard(hotelInfo, cardData) {
        console.log(`Écriture carte pour chambre ${cardData.roomNumber}...`);

        const result = CE_WriteCard(
            hotelInfo,
            cardData.buildingNo || 0,
            cardData.floorNo || 0,
            cardData.mac || '000000000000',
            BigInt(cardData.expiryTimestamp || 0),
            cardData.allowLockOut || false
        );

        if (result !== 0) {
            throw new Error(`Échec écriture carte (code: ${result})`);
        }

        console.log('✓ Carte écrite avec succès');

        // Bip de confirmation
        this.beep(200, 100, 2);

        return true;
    }

    async readCard(hotelInfo) {
        console.log('Lecture de la carte...');

        // Buffer pour recevoir les données
        const buffer = Buffer.alloc(4096);
        const result = CE_ReadCard(hotelInfo, buffer);

        if (result !== 0) {
            throw new Error(`Échec lecture carte (code: ${result})`);
        }

        // Convertir le buffer en string et parser le JSON
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
            throw new Error(`Échec récupération numéro carte (code: ${result})`);
        }

        return buffer.toString('utf8').replace(/\0/g, '');
    }

    async clearCard(hotelInfo) {
        console.log('Effacement de la carte...');
        const result = CE_ClearCard(hotelInfo);

        if (result !== 0) {
            throw new Error(`Échec effacement carte (code: ${result})`);
        }

        console.log('✓ Carte effacée avec succès');
        return true;
    }

    beep(len, interval, count) {
        try {
            CE_Beep(len, interval, count);
        } catch (e) {
            // Ignorer les erreurs de bip
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

// Routes API
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
            pendingRequests: CONFIG.pendingRequests.size
        });
    } catch (error) {
        res.json({
            status: 'online',
            encoderConnected: false,
            error: error.message
        });
    }
});

app.post('/api/encode-card', async (req, res) => {
    const requestId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const { roomNumber, mac, expiryDate, buildingNo = 1, floorNo } = req.body;

    if (!roomNumber) {
        return res.status(400).json({ error: 'roomNumber requis' });
    }

    CONFIG.pendingRequests.set(requestId, {
        id: requestId,
        roomNumber,
        mac: mac || '000000000000',
        buildingNo,
        floorNo: floorNo || roomNumber,
        expiryTimestamp: expiryDate ? Math.floor(new Date(expiryDate).getTime() / 1000) : 0,
        allowLockOut: true,
        status: 'pending',
        createdAt: new Date()
    });

    console.log(`📝 Demande d'encodage reçue: Chambre ${roomNumber} (ID: ${requestId})`);

    res.json({
        success: true,
        requestId,
        message: 'Demande d\'encodage en attente',
        instructions: 'Placez la carte sur l\'encodeur'
    });

    // Traiter la demande immédiatement
    processEncodingRequest(requestId).catch(console.error);
});

app.get('/api/status/:requestId', (req, res) => {
    const request = CONFIG.pendingRequests.get(req.params.requestId);

    if (!request) {
        return res.status(404).json({ error: 'Requête non trouvée' });
    }

    res.json(request);
});

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

app.post('/api/get-card-number', async (req, res) => {
    try {
        await encoderService.connect();
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
            error: error.message
        });
    }
});

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

async function processEncodingRequest(requestId) {
    const request = CONFIG.pendingRequests.get(requestId);
    if (!request) return;

    try {
        request.status = 'processing';

        const hotelInfo = await hotelInfoManager.getValidHotelInfo();

        await encoderService.connect();
        await encoderService.initializeEncoder(hotelInfo);

        await encoderService.writeCard(hotelInfo, {
            roomNumber: request.roomNumber,
            mac: request.mac,
            buildingNo: request.buildingNo,
            floorNo: request.floorNo,
            expiryTimestamp: request.expiryTimestamp,
            allowLockOut: request.allowLockOut
        });

        const cardData = await encoderService.readCard(hotelInfo);

        encoderService.disconnect();

        request.status = 'success';
        request.completedAt = new Date();
        request.cardData = cardData;

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
║  • Moteur: Koffi (pas de compilation native)            ║
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