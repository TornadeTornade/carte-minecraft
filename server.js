const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const multer = require('multer');
const { status } = require('minecraft-server-util');

const app = express();
const port = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PING_HISTORY_PATH = path.join(DATA_DIR, 'ping-history.json');
const STATS_PATH = path.join(DATA_DIR, 'stats.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Static
app.use(express.static(PUBLIC_DIR));

// Multer for uploads (memory storage for simplicity)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

async function ensureDataFiles() {
	await fsp.mkdir(DATA_DIR, { recursive: true });
	// ping-history.json
	try {
		await fsp.access(PING_HISTORY_PATH);
	} catch {
		await fsp.writeFile(PING_HISTORY_PATH, JSON.stringify({ samples: [] }, null, 2));
	}
	// stats.json
	try {
		await fsp.access(STATS_PATH);
	} catch {
		await fsp.writeFile(STATS_PATH, JSON.stringify({ players: {}, updatedAt: new Date().toISOString() }, null, 2));
	}
	// config.json
	try {
		await fsp.access(CONFIG_PATH);
	} catch {
		const defaultConfig = {
			host: process.env.MC_HOST || 'localhost',
			port: Number(process.env.MC_PORT || 25565),
			pingIntervalSec: Number(process.env.PING_INTERVAL_SEC || 0)
		};
		await fsp.writeFile(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
	}
}

function normalizeMotd(motd) {
	if (!motd) return '';
	if (typeof motd === 'string') return motd;
	if (motd.clean) return Array.isArray(motd.clean) ? motd.clean.join('\n') : String(motd.clean);
	if (motd.raw) return Array.isArray(motd.raw) ? motd.raw.join('\n') : String(motd.raw);
	if (motd.html) return Array.isArray(motd.html) ? motd.html.join('\n') : String(motd.html);
	return String(motd);
}

// GET /api/config
app.get('/api/config', async (req, res) => {
	try {
		const buf = await fsp.readFile(CONFIG_PATH, 'utf8');
		res.json(JSON.parse(buf));
	} catch (err) {
		res.status(500).json({ error: 'Failed to read config', details: String(err) });
	}
});

// GET /api/ping
app.get('/api/ping', async (req, res) => {
	const host = req.query.host || process.env.MC_HOST || 'localhost';
	const port = Number(req.query.port || process.env.MC_PORT || 25565);
	try {
		const result = await status(host, port, { enableSRV: true, timeout: 5000 });
		const playersList = Array.isArray(result?.players?.sample) ? result.players.sample.map(p => p.name || p.nameRaw || p.id || p) : [];
		res.json({
			online: true,
			host,
			port,
			players: {
				online: result?.players?.online ?? 0,
				max: result?.players?.max ?? 0,
				list: playersList
			},
			version: result?.version?.name || result?.version?.protocol || null,
			motd: normalizeMotd(result?.motd),
			favicon: result?.favicon || null,
			latencyMs: result?.roundTripLatency || null,
			obtainedAt: new Date().toISOString()
		});
	} catch (err) {
		res.json({ online: false, host, port, error: String(err) });
	}
});

// GET /api/ping-history
app.get('/api/ping-history', async (req, res) => {
	try {
		const buf = await fsp.readFile(PING_HISTORY_PATH, 'utf8');
		const data = JSON.parse(buf);
		res.json(data);
	} catch (err) {
		res.status(500).json({ error: 'Failed to read ping history', details: String(err) });
	}
});

// GET /api/stats
app.get('/api/stats', async (req, res) => {
	try {
		const buf = await fsp.readFile(STATS_PATH, 'utf8');
		res.json(JSON.parse(buf));
	} catch (err) {
		res.status(500).json({ error: 'Failed to read stats', details: String(err) });
	}
});

// POST /api/import - accepts JSON uploads; multipart field "file" or raw body
app.post('/api/import', upload.single('file'), async (req, res) => {
	try {
		let content;
		if (req.file) {
			content = req.file.buffer.toString('utf8');
		} else if (req.is('application/json')) {
			content = JSON.stringify(req.body);
		} else if (typeof req.body === 'string') {
			content = req.body;
		} else {
			return res.status(400).json({ error: 'No data provided. Upload a JSON file in field "file" or send JSON body.' });
		}

		let incoming = {};
		try {
			incoming = JSON.parse(content);
		} catch (e) {
			return res.status(400).json({ error: 'Invalid JSON', details: String(e) });
		}

		// Expected format: { players: { [username]: { playtimeSeconds, kills, deaths, blocksMined, blocksPlaced, distance, sessions: [...] } } }
		if (!incoming || typeof incoming !== 'object' || !incoming.players || typeof incoming.players !== 'object') {
			return res.status(400).json({ error: 'Invalid schema: expected root { players: { ... } }' });
		}

		// Merge into existing stats
		const currentRaw = await fsp.readFile(STATS_PATH, 'utf8');
		const current = JSON.parse(currentRaw);

		const merged = { players: { ...(current.players || {}) }, updatedAt: new Date().toISOString() };
		for (const [username, stats] of Object.entries(incoming.players)) {
			merged.players[username] = { ...(merged.players[username] || {}), ...stats };
		}

		await fsp.writeFile(STATS_PATH, JSON.stringify(merged, null, 2));
		res.json({ ok: true, updatedAt: merged.updatedAt, totalPlayers: Object.keys(merged.players).length });
	} catch (err) {
		res.status(500).json({ error: 'Failed to import stats', details: String(err) });
	}
});

async function appendPingSample(sample) {
	try {
		const buf = await fsp.readFile(PING_HISTORY_PATH, 'utf8');
		const data = JSON.parse(buf);
		data.samples.push(sample);
		// Keep last 7 days roughly (60s interval -> ~10080 entries), cap at 15000
		if (data.samples.length > 15000) {
			data.samples = data.samples.slice(-15000);
		}
		await fsp.writeFile(PING_HISTORY_PATH, JSON.stringify(data, null, 2));
	} catch (err) {
		console.error('Failed to append ping sample:', err);
	}
}

async function startSchedulerIfConfigured() {
	try {
		const cfg = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
		if (!cfg.pingIntervalSec || cfg.pingIntervalSec <= 0) return;
		const intervalMs = cfg.pingIntervalSec * 1000;
		console.log(`Starting ping scheduler every ${cfg.pingIntervalSec}s for ${cfg.host}:${cfg.port}`);
		setInterval(async () => {
			try {
				const result = await status(cfg.host, cfg.port, { enableSRV: true, timeout: 5000 });
				const sample = {
					at: new Date().toISOString(),
					online: true,
					playersOnline: result?.players?.online ?? 0,
					playersMax: result?.players?.max ?? 0
				};
				await appendPingSample(sample);
			} catch (e) {
				await appendPingSample({ at: new Date().toISOString(), online: false });
			}
		}, intervalMs);
	} catch (e) {
		console.warn('Scheduler not started:', e);
	}
}

(async () => {
	await ensureDataFiles();
	app.listen(port, () => {
		console.log(`Server running on http://localhost:${port}`);
	});
	startSchedulerIfConfigured();
})();