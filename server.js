// server.js com CORS corrigido
const express    = require(‘express’);
const cors       = require(‘cors’);
const bcrypt     = require(‘bcrypt’);
const jwt        = require(‘jsonwebtoken’);
const { Pool }   = require(‘pg’);
const { MercadoPagoConfig, Payment } = require(‘mercadopago’);
require(‘dotenv’).config();

const app  = express();
const port = process.env.PORT || 3000;

// CORS liberado para qualquer origem
app.use(cors({
origin: ‘*’,
methods: [‘GET’,‘POST’,‘PUT’,‘PATCH’,‘DELETE’,‘OPTIONS’],
allowedHeaders: [‘Content-Type’,‘Authorization’,‘x-admin-key’]
}));
app.options(’*’, cors());
app.use(express.json());

const db = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: { rejectUnauthorized: false }
});

const mpClient = new MercadoPagoConfig({
accessToken: process.env.MP_ACCESS_TOKEN,
options: { timeout: 5000 }
});
const mpPayment = new Payment(mpClient);

async function setupDatabase() {
await db.query(`CREATE TABLE IF NOT EXISTS users ( id          SERIAL PRIMARY KEY, nome        VARCHAR(100) NOT NULL, cpf         VARCHAR(14)  UNIQUE NOT NULL, email       VARCHAR(150) UNIQUE NOT NULL, telefone    VARCHAR(20), senha_hash  VARCHAR(255) NOT NULL, saldo       DECIMAL(10,2) DEFAULT 0.00, avatar      VARCHAR(10)  DEFAULT '😎', criado_em   TIMESTAMP DEFAULT NOW() ); CREATE TABLE IF NOT EXISTS transacoes ( id              SERIAL PRIMARY KEY, user_id         INTEGER REFERENCES users(id), tipo            VARCHAR(20) NOT NULL, valor           DECIMAL(10,2) NOT NULL, status          VARCHAR(20) DEFAULT 'pendente', mp_payment_id   VARCHAR(100), pix_chave       VARCHAR(200), criado_em       TIMESTAMP DEFAULT NOW() ); CREATE TABLE IF NOT EXISTS partidas ( id            SERIAL PRIMARY KEY, mesa_valor    DECIMAL(10,2), modo          VARCHAR(20), status        VARCHAR(20) DEFAULT 'aberta', criado_em     TIMESTAMP DEFAULT NOW() ); CREATE TABLE IF NOT EXISTS partida_jogadores ( id          SERIAL PRIMARY KEY, partida_id  INTEGER REFERENCES partidas(id), user_id     INTEGER REFERENCES users(id), dupla       INTEGER, ganhou      BOOLEAN, premio      DECIMAL(10,2) DEFAULT 0 );`);
console.log(‘Banco de dados configurado!’);
}

function authMiddleware(req, res, next) {
const token = req.headers.authorization?.replace(’Bearer ’, ‘’);
if (!token) return res.status(401).json({ erro: ‘Token necessario’ });
try {
req.user = jwt.verify(token, process.env.JWT_SECRET);
next();
} catch {
res.status(401).json({ erro: ‘Token invalido’ });
}
}

// HEALTH CHECK
app.get(’/health’, (req, res) => res.json({ ok: true, ts: new Date() }));

// AUTH
app.post(’/auth/cadastro’, async (req, res) => {
const { nome, cpf, email, telefone, senha } = req.body;
if (!nome || !cpf || !email || !senha)
return res.status(400).json({ erro: ‘Campos obrigatorios faltando’ });
if (senha.length < 6)
return res.status(400).json({ erro: ‘Senha deve ter pelo menos 6 caracteres’ });
try {
const senhaHash = await bcrypt.hash(senha, 10);
const result = await db.query(
‘INSERT INTO users (nome, cpf, email, telefone, senha_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id, nome, email, saldo, avatar’,
[nome, cpf, email, telefone || ‘’, senhaHash]
);
const user = result.rows[0];
const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: ‘7d’ });
res.json({ token, user });
} catch (err) {
if (err.code === ‘23505’) return res.status(400).json({ erro: ‘CPF ou e-mail ja cadastrado’ });
console.error(err);
res.status(500).json({ erro: ‘Erro ao criar conta’ });
}
});

app.post(’/auth/login’, async (req, res) => {
const { email, senha } = req.body;
try {
const result = await db.query(‘SELECT * FROM users WHERE email=$1’, [email]);
const user = result.rows[0];
if (!user) return res.status(401).json({ erro: ‘E-mail ou senha incorretos’ });
const ok = await bcrypt.compare(senha, user.senha_hash);
if (!ok) return res.status(401).json({ erro: ‘E-mail ou senha incorretos’ });
const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: ‘7d’ });
res.json({ token, user: { id: user.id, nome: user.nome, email: user.email, saldo: user.saldo, avatar: user.avatar } });
} catch (err) {
console.error(err);
res.status(500).json({ erro: ‘Erro ao fazer login’ });
}
});

app.get(’/auth/me’, authMiddleware, async (req, res) => {
const result = await db.query(‘SELECT id, nome, email, saldo, avatar FROM users WHERE id=$1’, [req.user.id]);
res.json(result.rows[0]);
});

app.patch(’/auth/avatar’, authMiddleware, async (req, res) => {
const { avatar } = req.body;
await db.query(‘UPDATE users SET avatar=$1 WHERE id=$2’, [avatar, req.user.id]);
res.json({ ok: true, avatar });
});

// DEPOSITO
app.post(’/deposito/criar’, authMiddleware, async (req, res) => {
const { valor } = req.body;
if (!valor || valor < 1) return res.status(400).json({ erro: ‘Valor minimo: R$ 1,00’ });
try {
const payment = await mpPayment.create({
body: {
transaction_amount: Number(valor),
description: ‘TrucoKing - Deposito’,
payment_method_id: ‘pix’,
payer: { email: req.user.email },
notification_url: `${process.env.BACKEND_URL}/webhook/mp`,
metadata: { user_id: req.user.id, tipo: ‘deposito’ }
}
});
const tx = await db.query(
‘INSERT INTO transacoes (user_id, tipo, valor, status, mp_payment_id) VALUES ($1,$2,$3,$4,$5) RETURNING id’,
[req.user.id, ‘deposito’, valor, ‘pendente’, String(payment.id)]
);
res.json({
transacao_id: tx.rows[0].id,
qr_code: payment.point_of_interaction.transaction_data.qr_code,
qr_code_base64: payment.point_of_interaction.transaction_data.qr_code_base64,
valor
});
} catch (err) {
console.error(‘Erro ao criar Pix:’, err);
res.status(500).json({ erro: ‘Erro ao gerar Pix’ });
}
});

app.get(’/deposito/status/:txId’, authMiddleware, async (req, res) => {
const result = await db.query(‘SELECT * FROM transacoes WHERE id=$1 AND user_id=$2’, [req.params.txId, req.user.id]);
const tx = result.rows[0];
if (!tx) return res.status(404).json({ erro: ‘Transacao nao encontrada’ });
res.json({ status: tx.status, valor: tx.valor });
});

// WEBHOOK
app.post(’/webhook/mp’, async (req, res) => {
res.sendStatus(200);
const { type, data } = req.body;
if (type !== ‘payment’) return;
try {
const payment = await mpPayment.get({ id: data.id });
if (payment.status !== ‘approved’) return;
const userId = payment.metadata?.user_id;
const valor  = payment.transaction_amount;
const mpId   = String(payment.id);
const existe = await db.query(‘SELECT id FROM transacoes WHERE mp_payment_id=$1 AND status=$2’, [mpId, ‘aprovado’]);
if (existe.rows.length > 0) return;
await db.query(‘UPDATE users SET saldo = saldo + $1 WHERE id=$2’, [valor, userId]);
await db.query(‘UPDATE transacoes SET status=$1 WHERE mp_payment_id=$2’, [‘aprovado’, mpId]);
console.log(‘Deposito aprovado: R$’ + valor + ’ para user #’ + userId);
} catch (err) {
console.error(‘Erro no webhook:’, err);
}
});

// SAQUE
app.post(’/saque/solicitar’, authMiddleware, async (req, res) => {
const { valor, pix_chave } = req.body;
if (!valor || valor < 20) return res.status(400).json({ erro: ‘Valor minimo de saque: R$ 20,00’ });
if (!pix_chave) return res.status(400).json({ erro: ‘Informe sua chave Pix’ });
try {
const userResult = await db.query(‘SELECT saldo FROM users WHERE id=$1’, [req.user.id]);
const saldo = parseFloat(userResult.rows[0].saldo);
if (saldo < valor) return res.status(400).json({ erro: ‘Saldo insuficiente’ });
await db.query(‘UPDATE users SET saldo = saldo - $1 WHERE id=$2’, [valor, req.user.id]);
const tx = await db.query(
‘INSERT INTO transacoes (user_id, tipo, valor, status, pix_chave) VALUES ($1,$2,$3,$4,$5) RETURNING id’,
[req.user.id, ‘saque’, valor, ‘processando’, pix_chave]
);
res.json({ ok: true, mensagem: ‘Saque solicitado! Pix em ate 5 minutos.’, transacao_id: tx.rows[0].id });
} catch (err) {
console.error(err);
res.status(500).json({ erro: ‘Erro ao solicitar saque’ });
}
});

// CARTEIRA
app.get(’/carteira’, authMiddleware, async (req, res) => {
const saldo = await db.query(‘SELECT saldo FROM users WHERE id=$1’, [req.user.id]);
const txs   = await db.query(‘SELECT tipo, valor, status, criado_em FROM transacoes WHERE user_id=$1 ORDER BY criado_em DESC LIMIT 50’, [req.user.id]);
res.json({ saldo: saldo.rows[0].saldo, transacoes: txs.rows });
});

// ADMIN
app.get(’/admin/usuarios’, async (req, res) => {
if (req.headers[‘x-admin-key’] !== process.env.ADMIN_KEY) return res.status(403).json({ erro: ‘Acesso negado’ });
const users = await db.query(‘SELECT id, nome, email, saldo, criado_em FROM users ORDER BY criado_em DESC’);
res.json(users.rows);
});

app.get(’/admin/transacoes’, async (req, res) => {
if (req.headers[‘x-admin-key’] !== process.env.ADMIN_KEY) return res.status(403).json({ erro: ‘Acesso negado’ });
const txs = await db.query(‘SELECT t.*, u.nome, u.email FROM transacoes t JOIN users u ON t.user_id=u.id ORDER BY t.criado_em DESC LIMIT 200’);
res.json(txs.rows);
});

setupDatabase().then(() => {
app.listen(port, () => console.log(’TrucoKing Server na porta ’ + port));
}).catch(err => { console.error(err); process.exit(1); });
