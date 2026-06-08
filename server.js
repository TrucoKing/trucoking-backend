// ================================================================
// TRUCOKING — BACKEND COMPLETO
// Node.js + Express + PostgreSQL + Mercado Pago
// ================================================================

const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const { Pool }   = require('pg');
const { MercadoPagoConfig, Payment, MerchantOrder } = require('mercadopago');
require('dotenv').config();

const app  = express();
const port = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// ── Banco de dados ────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ── Mercado Pago ──────────────────────────────────────────────
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
  options: { timeout: 5000 }
});
const mpPayment = new Payment(mpClient);

// ================================================================
// BANCO DE DADOS — Criar tabelas se não existirem
// ================================================================
async function setupDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      nome        VARCHAR(100) NOT NULL,
      cpf         VARCHAR(14)  UNIQUE NOT NULL,
      email       VARCHAR(150) UNIQUE NOT NULL,
      telefone    VARCHAR(20),
      senha_hash  VARCHAR(255) NOT NULL,
      saldo       DECIMAL(10,2) DEFAULT 0.00,
      avatar      VARCHAR(10)  DEFAULT '😎',
      criado_em   TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS transacoes (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER REFERENCES users(id),
      tipo            VARCHAR(20) NOT NULL,   -- 'deposito' | 'saque' | 'vitoria' | 'derrota'
      valor           DECIMAL(10,2) NOT NULL,
      status          VARCHAR(20) DEFAULT 'pendente', -- 'pendente' | 'aprovado' | 'rejeitado'
      mp_payment_id   VARCHAR(100),           -- ID do pagamento no Mercado Pago
      pix_chave       VARCHAR(200),           -- chave pix do usuário (para saque)
      pix_tipo        VARCHAR(20),            -- tipo da chave: cpf | email | telefone | aleatoria
      criado_em       TIMESTAMP DEFAULT NOW()
    );

    -- Garante a coluna mesmo em bancos já existentes
    ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS pix_tipo VARCHAR(20);

    CREATE TABLE IF NOT EXISTS partidas (
      id            SERIAL PRIMARY KEY,
      mesa_valor    DECIMAL(10,2),
      modo          VARCHAR(20),  -- 'mineiro' | 'paulista'
      status        VARCHAR(20) DEFAULT 'aberta',
      criado_em     TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS partida_jogadores (
      id          SERIAL PRIMARY KEY,
      partida_id  INTEGER REFERENCES partidas(id),
      user_id     INTEGER REFERENCES users(id),
      dupla       INTEGER,  -- 0 ou 1
      ganhou      BOOLEAN,
      premio      DECIMAL(10,2) DEFAULT 0
    );
  `);

  console.log('✅ Banco de dados configurado!');
}

// ================================================================
// HELPERS
// ================================================================
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Token necessário' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ erro: 'Token inválido' });
  }
}

// ================================================================
// ROTAS DE AUTH
// ================================================================

// POST /auth/cadastro
app.post('/auth/cadastro', async (req, res) => {
  const { nome, cpf, email, telefone, senha } = req.body;

  if (!nome || !cpf || !email || !senha)
    return res.status(400).json({ erro: 'Campos obrigatórios faltando' });

  if (senha.length < 6)
    return res.status(400).json({ erro: 'Senha deve ter pelo menos 6 caracteres' });

  try {
    const senhaHash = await bcrypt.hash(senha, 10);
    const result = await db.query(
      'INSERT INTO users (nome, cpf, email, telefone, senha_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id, nome, email, saldo, avatar',
      [nome, cpf, email, telefone, senhaHash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ erro: 'CPF ou e-mail já cadastrado' });
    }
    console.error(err);
    res.status(500).json({ erro: 'Erro ao criar conta' });
  }
});

// POST /auth/login
app.post('/auth/login', async (req, res) => {
  const { email, senha } = req.body;
  try {
    const result = await db.query('SELECT * FROM users WHERE email=$1', [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ erro: 'E-mail ou senha incorretos' });

    const ok = await bcrypt.compare(senha, user.senha_hash);
    if (!ok) return res.status(401).json({ erro: 'E-mail ou senha incorretos' });

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: { id: user.id, nome: user.nome, email: user.email, saldo: user.saldo, avatar: user.avatar }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao fazer login' });
  }
});

// GET /auth/me — retorna dados do usuário logado
app.get('/auth/me', authMiddleware, async (req, res) => {
  const result = await db.query(
    'SELECT id, nome, email, saldo, avatar FROM users WHERE id=$1',
    [req.user.id]
  );
  res.json(result.rows[0]);
});

// PATCH /auth/avatar — atualiza avatar
app.patch('/auth/avatar', authMiddleware, async (req, res) => {
  const { avatar } = req.body;
  await db.query('UPDATE users SET avatar=$1 WHERE id=$2', [avatar, req.user.id]);
  res.json({ ok: true, avatar });
});

// ================================================================
// ROTAS DE DEPÓSITO (PIX via Mercado Pago)
// ================================================================

// POST /deposito/criar — gera QR Code Pix
app.post('/deposito/criar', authMiddleware, async (req, res) => {
  const { valor } = req.body;

  if (!valor || valor < 1)
    return res.status(400).json({ erro: 'Valor mínimo: R$ 1,00' });

  try {
    // Cria pagamento Pix no Mercado Pago
    const payment = await mpPayment.create({
      body: {
        transaction_amount: Number(valor),
        description: `TrucoKing - Depósito`,
        payment_method_id: 'pix',
        payer: {
          email: req.user.email,
          identification: { type: 'CPF', number: req.user.cpf }
        },
        notification_url: `${process.env.BACKEND_URL}/webhook/mp`,
        metadata: { user_id: req.user.id, tipo: 'deposito' }
      }
    });

    // Salva transação como pendente
    const tx = await db.query(
      'INSERT INTO transacoes (user_id, tipo, valor, status, mp_payment_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.user.id, 'deposito', valor, 'pendente', String(payment.id)]
    );

    res.json({
      transacao_id: tx.rows[0].id,
      qr_code: payment.point_of_interaction.transaction_data.qr_code,
      qr_code_base64: payment.point_of_interaction.transaction_data.qr_code_base64,
      valor,
      expira_em: payment.date_of_expiration
    });
  } catch (err) {
    console.error('Erro ao criar Pix:', err);
    res.status(500).json({ erro: 'Erro ao gerar Pix. Tente novamente.' });
  }
});

// GET /deposito/status/:txId — verifica status do pagamento
app.get('/deposito/status/:txId', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM transacoes WHERE id=$1 AND user_id=$2',
      [req.params.txId, req.user.id]
    );
    const tx = result.rows[0];
    if (!tx) return res.status(404).json({ erro: 'Transação não encontrada' });
    res.json({ status: tx.status, valor: tx.valor });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao verificar status' });
  }
});

// ================================================================
// WEBHOOK DO MERCADO PAGO — chamado quando pagamento chega
// ================================================================
app.post('/webhook/mp', async (req, res) => {
  res.sendStatus(200); // responde imediatamente para o MP

  const { type, data } = req.body;
  if (type !== 'payment') return;

  try {
    const payment = await mpPayment.get({ id: data.id });
    if (payment.status !== 'approved') return;

    const userId  = payment.metadata?.user_id;
    const tipo    = payment.metadata?.tipo;
    const valor   = payment.transaction_amount;
    const mpId    = String(payment.id);

    // Evitar creditar duas vezes
    const existe = await db.query(
      'SELECT id FROM transacoes WHERE mp_payment_id=$1 AND status=$2',
      [mpId, 'aprovado']
    );
    if (existe.rows.length > 0) return;

    if (tipo === 'deposito' && userId) {
      // Credita saldo no usuário
      await db.query('UPDATE users SET saldo = saldo + $1 WHERE id=$2', [valor, userId]);
      // Atualiza transação
      await db.query(
        'UPDATE transacoes SET status=$1 WHERE mp_payment_id=$2',
        ['aprovado', mpId]
      );
      console.log(`✅ Depósito aprovado: R$ ${valor} para user #${userId}`);
    }
  } catch (err) {
    console.error('Erro no webhook:', err);
  }
});

// ================================================================
// ROTAS DE SAQUE (Pix de saída via Mercado Pago)
// ================================================================

// POST /saque/solicitar
app.post('/saque/solicitar', authMiddleware, async (req, res) => {
  const { valor, pix_chave, pix_tipo } = req.body;
  // pix_tipo: 'cpf' | 'email' | 'telefone' | 'aleatoria'

  if (!valor || valor < 20)
    return res.status(400).json({ erro: 'Valor mínimo de saque: R$ 20,00' });
  if (!pix_chave)
    return res.status(400).json({ erro: 'Informe sua chave Pix' });

  // Transação atômica: debita saldo e cria solicitação juntos
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Trava a linha do usuário para evitar saque duplo simultâneo
    const userResult = await client.query('SELECT saldo FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
    const saldo = parseFloat(userResult.rows[0].saldo);

    if (saldo < valor) {
      await client.query('ROLLBACK');
      return res.status(400).json({ erro: 'Saldo insuficiente' });
    }

    // Debita o saldo na hora (fica reservado) e registra como PENDENTE para aprovação manual
    await client.query('UPDATE users SET saldo = saldo - $1 WHERE id=$2', [valor, req.user.id]);
    const tx = await client.query(
      'INSERT INTO transacoes (user_id, tipo, valor, status, pix_chave, pix_tipo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [req.user.id, 'saque', valor, 'pendente', pix_chave, pix_tipo || 'aleatoria']
    );

    await client.query('COMMIT');

    res.json({
      ok: true,
      mensagem: 'Saque solicitado! Será processado em até 24h.',
      transacao_id: tx.rows[0].id
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao solicitar saque:', err);
    res.status(500).json({ erro: 'Erro ao solicitar saque' });
  } finally {
    client.release();
  }
});

// ================================================================
// ADMIN — Gestão de saques (aprovar / rejeitar manualmente)
// ================================================================

// GET /admin/saques — lista saques pendentes para você pagar
app.get('/admin/saques', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(403).json({ erro: 'Acesso negado' });

  const status = req.query.status || 'pendente';
  const r = await db.query(
    `SELECT t.id, t.valor, t.status, t.pix_chave, t.pix_tipo, t.criado_em,
            u.id AS user_id, u.nome, u.email, u.cpf
       FROM transacoes t
       JOIN users u ON t.user_id = u.id
      WHERE t.tipo='saque' AND t.status=$1
      ORDER BY t.criado_em ASC`,
    [status]
  );
  res.json(r.rows);
});

// POST /admin/saques/:id/aprovar — marca como pago (você já fez o Pix manualmente)
app.post('/admin/saques/:id/aprovar', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(403).json({ erro: 'Acesso negado' });

  const r = await db.query(
    "UPDATE transacoes SET status='aprovado' WHERE id=$1 AND tipo='saque' AND status='pendente' RETURNING id",
    [req.params.id]
  );
  if (!r.rows[0]) return res.status(404).json({ erro: 'Saque não encontrado ou já processado' });
  res.json({ ok: true, mensagem: 'Saque marcado como pago' });
});

// POST /admin/saques/:id/rejeitar — recusa e estorna o saldo ao jogador
app.post('/admin/saques/:id/rejeitar', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(403).json({ erro: 'Acesso negado' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const tx = await client.query(
      "SELECT user_id, valor FROM transacoes WHERE id=$1 AND tipo='saque' AND status='pendente' FOR UPDATE",
      [req.params.id]
    );
    if (!tx.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'Saque não encontrado ou já processado' });
    }
    // Estorna o saldo de volta ao jogador
    await client.query('UPDATE users SET saldo = saldo + $1 WHERE id=$2', [tx.rows[0].valor, tx.rows[0].user_id]);
    await client.query("UPDATE transacoes SET status='rejeitado' WHERE id=$1", [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true, mensagem: 'Saque rejeitado e saldo estornado' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao rejeitar saque:', err);
    res.status(500).json({ erro: 'Erro ao rejeitar saque' });
  } finally {
    client.release();
  }
});

// ================================================================
// ROTAS DO JOGO
// ================================================================

// POST /jogo/entrar — debita entrada e cria/entra na partida
app.post('/jogo/entrar', authMiddleware, async (req, res) => {
  const { mesa_valor, modo } = req.body;

  try {
    const userResult = await db.query('SELECT saldo FROM users WHERE id=$1', [req.user.id]);
    const saldo = parseFloat(userResult.rows[0].saldo);

    if (saldo < mesa_valor)
      return res.status(400).json({ erro: 'Saldo insuficiente' });

    // Debita entrada
    await db.query('UPDATE users SET saldo = saldo - $1 WHERE id=$2', [mesa_valor, req.user.id]);
    await db.query(
      'INSERT INTO transacoes (user_id, tipo, valor, status) VALUES ($1,$2,$3,$4)',
      [req.user.id, 'entrada_mesa', mesa_valor, 'aprovado']
    );

    // Encontra partida aberta ou cria nova
    let partida = await db.query(
      "SELECT p.id FROM partidas p LEFT JOIN partida_jogadores pj ON p.id=pj.partida_id WHERE p.mesa_valor=$1 AND p.modo=$2 AND p.status='aberta' GROUP BY p.id HAVING COUNT(pj.id)<4 LIMIT 1",
      [mesa_valor, modo]
    );

    let partida_id;
    if (partida.rows.length === 0) {
      const nova = await db.query(
        'INSERT INTO partidas (mesa_valor, modo) VALUES ($1,$2) RETURNING id',
        [mesa_valor, modo]
      );
      partida_id = nova.rows[0].id;
    } else {
      partida_id = partida.rows[0].id;
    }

    // Adiciona jogador
    const jogCount = await db.query(
      'SELECT COUNT(*) FROM partida_jogadores WHERE partida_id=$1', [partida_id]
    );
    const dupla = parseInt(jogCount.rows[0].count) % 2; // alterna dupla 0/1
    await db.query(
      'INSERT INTO partida_jogadores (partida_id, user_id, dupla) VALUES ($1,$2,$3)',
      [partida_id, req.user.id, dupla]
    );

    res.json({ ok: true, partida_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao entrar na mesa' });
  }
});

// POST /jogo/resultado — registra resultado e paga vencedores
app.post('/jogo/resultado', authMiddleware, async (req, res) => {
  const { partida_id, dupla_vencedora } = req.body;
  const TAXA = 0.85; // 85% vai para vencedores, 15% plataforma

  try {
    const partida = await db.query('SELECT * FROM partidas WHERE id=$1', [partida_id]);
    if (!partida.rows[0]) return res.status(404).json({ erro: 'Partida não encontrada' });

    const { mesa_valor } = partida.rows[0];
    const totalPot  = mesa_valor * 4;
    const premioPorJogador = (totalPot * TAXA) / 2; // 2 vencedores

    const jogadores = await db.query(
      'SELECT * FROM partida_jogadores WHERE partida_id=$1', [partida_id]
    );

    for (const j of jogadores.rows) {
      const ganhou = j.dupla === dupla_vencedora;
      await db.query(
        'UPDATE partida_jogadores SET ganhou=$1, premio=$2 WHERE id=$3',
        [ganhou, ganhou ? premioPorJogador : 0, j.id]
      );

      if (ganhou) {
        // Credita prêmio
        await db.query('UPDATE users SET saldo = saldo + $1 WHERE id=$2', [premioPorJogador, j.user_id]);
        await db.query(
          'INSERT INTO transacoes (user_id, tipo, valor, status) VALUES ($1,$2,$3,$4)',
          [j.user_id, 'vitoria', premioPorJogador, 'aprovado']
        );
      }
    }

    // Fecha partida
    await db.query("UPDATE partidas SET status='finalizada' WHERE id=$1", [partida_id]);

    res.json({ ok: true, premioPorJogador });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao registrar resultado' });
  }
});

// ================================================================
// ROTAS DE CARTEIRA
// ================================================================

// GET /carteira — saldo + histórico
app.get('/carteira', authMiddleware, async (req, res) => {
  try {
    const saldo = await db.query('SELECT saldo FROM users WHERE id=$1', [req.user.id]);
    const txs   = await db.query(
      'SELECT tipo, valor, status, criado_em FROM transacoes WHERE user_id=$1 ORDER BY criado_em DESC LIMIT 50',
      [req.user.id]
    );
    res.json({ saldo: saldo.rows[0].saldo, transacoes: txs.rows });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar carteira' });
  }
});

// ================================================================
// ROTA DE ADMIN — painel simples (proteger com senha admin)
// ================================================================
app.get('/admin/usuarios', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY)
    return res.status(403).json({ erro: 'Acesso negado' });

  const users = await db.query(
    'SELECT id, nome, email, saldo, criado_em FROM users ORDER BY criado_em DESC'
  );
  res.json(users.rows);
});

app.get('/admin/transacoes', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY)
    return res.status(403).json({ erro: 'Acesso negado' });

  const txs = await db.query(
    'SELECT t.*, u.nome, u.email FROM transacoes t JOIN users u ON t.user_id=u.id ORDER BY t.criado_em DESC LIMIT 200'
  );
  res.json(txs.rows);
});

// GET /health — verifica se servidor está online
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date() }));

// ================================================================
// INICIAR SERVIDOR
// ================================================================
setupDatabase().then(() => {
  app.listen(port, () => {
    console.log(`🎉 TrucoKing Server rodando na porta ${port}`);
  });
}).catch(err => {
  console.error('Erro ao conectar banco:', err);
  process.exit(1);
});
