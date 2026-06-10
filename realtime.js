// ============================================================
// TrucoKing — Multiplayer em tempo real (Fase 2)
// Estrutura de Socket.IO: conexao, autenticacao e SALAS.
//
// Nesta fase o objetivo e PROVAR o cano de tempo real:
//   - o jogador conecta e se autentica com o token
//   - entra numa sala (mesa) de um certo valor/modo
//   - todos na sala recebem aviso de quem entrou e quantos sao
//   - um "ping" de teste mostra que as abas conversam pelo servidor
//
// A engine de truco (engine/truco.js) ja existe e sera plugada
// na Fase 3 (distribuir cartas, validar jogadas, etc.).
// ============================================================

'use strict';

const engine = require('./engine/truco');

module.exports = function (io, deps) {
  const { jwt } = deps;

  // salas em memoria: { 'mesa:valor:modo': { jogadores:[{id,nome,socketId}], partida:null } }
  const salas = {};

  function salaId(valor, modo) {
    return `mesa:${valor}:${modo}`;
  }

  // --- Autenticacao do socket pelo token JWT ---
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error('sem token'));
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = { id: payload.id, nome: payload.nome || payload.email || 'Jogador' };
      next();
    } catch (e) {
      next(new Error('token invalido'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`🔌 conectou: ${socket.user.nome} (${socket.id})`);

    // entrar numa mesa
    socket.on('entrar_mesa', ({ valor, modo }) => {
      const id = salaId(valor, modo || 'mineiro');
      if (!salas[id]) salas[id] = { jogadores: [], partida: null };
      const sala = salas[id];

      // evita duplicar o mesmo usuario na sala
      if (!sala.jogadores.some(j => j.id === socket.user.id)) {
        sala.jogadores.push({ id: socket.user.id, nome: socket.user.nome, socketId: socket.id });
      }
      socket.join(id);
      socket.salaAtual = id;

      // avisa todos da sala quem esta presente
      io.to(id).emit('sala_atualizada', {
        sala: id,
        total: sala.jogadores.length,
        jogadores: sala.jogadores.map(j => ({ id: j.id, nome: j.nome })),
      });
      console.log(`➡️  ${socket.user.nome} entrou em ${id} (${sala.jogadores.length} na sala)`);
    });

    // ping de teste: um manda, todos na sala recebem (prova do tempo real)
    socket.on('ping_teste', (msg) => {
      if (!socket.salaAtual) return;
      io.to(socket.salaAtual).emit('pong_teste', {
        de: socket.user.nome,
        msg: String(msg || '').slice(0, 200),
        ts: Date.now(),
      });
    });

    // sair da mesa
    socket.on('sair_mesa', () => sairDaSala(socket));

    socket.on('disconnect', () => {
      console.log(`❌ saiu: ${socket.user.nome}`);
      sairDaSala(socket);
    });
  });

  function sairDaSala(socket) {
    const id = socket.salaAtual;
    if (!id || !salas[id]) return;
    const sala = salas[id];
    sala.jogadores = sala.jogadores.filter(j => j.socketId !== socket.id);
    socket.leave(id);
    socket.salaAtual = null;
    io.to(id).emit('sala_atualizada', {
      sala: id,
      total: sala.jogadores.length,
      jogadores: sala.jogadores.map(j => ({ id: j.id, nome: j.nome })),
    });
    // limpa sala vazia
    if (sala.jogadores.length === 0) delete salas[id];
  }

  console.log('✅ Multiplayer (Fase 2) carregado');
};
