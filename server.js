const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { MercadoPagoConfig, Payment } = require('mercadopago');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.options('*', cors());
app.use(express.json());

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const mpConfig = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN, options: { timeout: 5000 } });
const mp = new Payment(mpConfig);

console.log('MP Token:', process.env.MP_ACCESS_TOKEN ? process.env.MP_ACCESS_TOKEN.substring(0,20) + '...' : 'NAO DEFINIDO');

console.log("MP Token inicio:", process.env.MP_ACCESS_TOKEN ? process.env.MP_ACCESS_TOKEN.substring(0,20) + "..." : "NAO DEFINIDO");

async function setup() {
  await db.query(`CREATE TABLE IF NOT EXISTS users(
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100),
    cpf VARCHAR(14) UNIQUE,
    email VARCHAR(150) UNIQUE,
    telefone VARCHAR(20),
    senha_hash VARCHAR(255),
    saldo DECIMAL(10,2) DEFAULT 0,
    avatar VARCHAR(50) DEFAULT 'smile',
    criado_em TIMESTAMP DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS transacoes(
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    tipo VARCHAR(20),
    valor DECIMAL(10,2),
    status VARCHAR(20) DEFAULT 'pendente',
    mp_payment_id VARCHAR(100),
    pix_chave VARCHAR(200),
    criado_em TIMESTAMP DEFAULT NOW()
  )`);
  console.log('DB OK');
}

function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!t) return res.status(401).json({ erro: 'Token necessario' });
  try {
    req.user = jwt.verify(t, process.env.JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ erro: 'Token invalido' });
  }
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/auth/cadastro', async (req, res) => {
  const { nome, cpf, email, telefone, senha } = req.body;
  if (!nome || !cpf || !email || !senha) return res.status(400).json({ erro: 'Campos faltando' });
  if (senha.length < 6) return res.status(400).json({ erro: 'Senha curta' });
  try {
    const h = await bcrypt.hash(senha, 10);
    const r = await db.query(
      'INSERT INTO users(nome,cpf,email,telefone,senha_hash) VALUES($1,$2,$3,$4,$5) RETURNING id,nome,email,saldo,avatar',
      [nome, cpf, email, telefone || '', h]
    );
    const u = r.rows[0];
    const token = jwt.sign({ id: u.id, email: u.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: u });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ erro: 'CPF ou email ja cadastrado' });
    res.status(500).json({ erro: 'Erro ao criar conta' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { email, senha } = req.body;
  try {
    const r = await db.query('SELECT * FROM users WHERE email=$1', [email]);
    const u = r.rows[0];
    if (!u) return res.status(401).json({ erro: 'Email ou senha incorretos' });
    if (!await bcrypt.compare(senha, u.senha_hash)) return res.status(401).json({ erro: 'Email ou senha incorretos' });
    const token = jwt.sign({ id: u.id, email: u.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: u.id, nome: u.nome, email: u.email, saldo: u.saldo, avatar: u.avatar } });
  } catch (e) {
    res.status(500).json({ erro: 'Erro login' });
  }
});

app.get('/auth/me', auth, async (req, res) => {
  const r = await db.query('SELECT id,nome,email,saldo,avatar FROM users WHERE id=$1', [req.user.id]);
  res.json(r.rows[0]);
});

app.patch('/auth/avatar', auth, async (req, res) => {
  await db.query('UPDATE users SET avatar=$1 WHERE id=$2', [req.body.avatar, req.user.id]);
  res.json({ ok: true });
});

app.post('/deposito/criar', auth, async (req, res) => {
  const { valor } = req.body;
  if (!valor || valor < 1) return res.status(400).json({ erro: 'Minimo R$ 1' });
  try {
    const p = await mp.create({
      body: {
        transaction_amount: Number(valor),
        description: 'TrucoKing',
        payment_method_id: 'pix',
        payer: { email: req.user.email },
        metadata: { user_id: req.user.id }
      }
    });
    const t = await db.query(
      'INSERT INTO transacoes(user_id,tipo,valor,status,mp_payment_id) VALUES($1,$2,$3,$4,$5) RETURNING id',
      [req.user.id, 'deposito', valor, 'pendente', String(p.id)]
    );
    res.json({
      transacao_id: t.rows[0].id,
      qr_code: p.point_of_interaction.transaction_data.qr_code,
      valor
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro pix' });
  }
});

app.get('/deposito/status/:id', auth, async (req, res) => {
  const r = await db.query(
    'SELECT status,valor FROM transacoes WHERE id=$1 AND user_id=$2',
    [req.params.id, req.user.id]
  );
  if (!r.rows[0]) return res.status(404).json({ erro: 'Nao encontrado' });
  res.json(r.rows[0]);
});

app.post('/webhook/mp', async (req, res) => {
  res.sendStatus(200);
  if (req.body.type !== 'payment') return;
  try {
    const p = await mp.get({ id: req.body.data.id });
    if (p.status !== 'approved') return;
    const uid = p.metadata && p.metadata.user_id;
    const v = p.transaction_amount;
    const mid = String(p.id);
    const ex = await db.query(
      'SELECT id FROM transacoes WHERE mp_payment_id=$1 AND status=$2',
      [mid, 'aprovado']
    );
    if (ex.rows.length) return;
    await db.query('UPDATE users SET saldo=saldo+$1 WHERE id=$2', [v, uid]);
    await db.query('UPDATE transacoes SET status=$1 WHERE mp_payment_id=$2', ['aprovado', mid]);
  } catch (e) {
    console.error(e);
  }
});

app.post('/saque/solicitar', auth, async (req, res) => {
  const { valor, pix_chave } = req.body;
  if (!valor || valor < 20) return res.status(400).json({ erro: 'Minimo R$ 20' });
  if (!pix_chave) return res.status(400).json({ erro: 'Informe chave pix' });
  const r = await db.query('SELECT saldo FROM users WHERE id=$1', [req.user.id]);
  if (parseFloat(r.rows[0].saldo) < valor) return res.status(400).json({ erro: 'Saldo insuficiente' });
  await db.query('UPDATE users SET saldo=saldo-$1 WHERE id=$2', [valor, req.user.id]);
  await db.query(
    'INSERT INTO transacoes(user_id,tipo,valor,status,pix_chave) VALUES($1,$2,$3,$4,$5)',
    [req.user.id, 'saque', valor, 'processando', pix_chave]
  );
  res.json({ ok: true });
});

app.get('/carteira', auth, async (req, res) => {
  const s = await db.query('SELECT saldo FROM users WHERE id=$1', [req.user.id]);
  const t = await db.query(
    'SELECT tipo,valor,status,criado_em FROM transacoes WHERE user_id=$1 ORDER BY criado_em DESC LIMIT 50',
    [req.user.id]
  );
  res.json({ saldo: s.rows[0].saldo, transacoes: t.rows });
});

app.get('/admin/usuarios', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(403).json({ erro: 'Negado' });
  const r = await db.query('SELECT id,nome,email,saldo,criado_em FROM users ORDER BY criado_em DESC');
  res.json(r.rows);
});


app.get('/admin/transacoes', async (req, res) => {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_KEY) return res.status(403).json({ erro: "Negado" });
  const r = await db.query("SELECT t.id,u.nome,u.email,t.tipo,t.valor,t.status,t.pix_chave,t.criado_em FROM transacoes t LEFT JOIN users u ON t.user_id=u.id ORDER BY t.criado_em DESC LIMIT 200");
  res.json(r.rows);
});

setup()
  .then(() => app.listen(port, () => console.log('OK porta ' + port)))
  .catch(e => { console.error(e); process.exit(1); });
