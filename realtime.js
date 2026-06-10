// ============================================================
// TrucoKing — Multiplayer em tempo real (Fases 2 + 3)
//
// Fase 2: conexao, autenticacao e SALAS (ja funcionando).
// Fase 3: quando 2 HUMANOS entram numa mesa, o servidor:
//   - monta os assentos (humanos em duplas OPOSTAS, bots no resto)
//   - cria a partida com a engine e distribui as cartas
//   - envia para cada humano APENAS a mao dele (anti-trapaca)
//
// Assentos: 0 e 2 = dupla NOS; 1 e 3 = dupla ELES.
// Os 2 humanos ficam em 0 e 1 (duplas opostas); 2 e 3 viram bots.
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

      // FASE 3: com 2 humanos e nenhuma partida rolando, comeca a partida
      if (sala.jogadores.length >= 2 && !sala.partida) {
        iniciarPartida(id);
      }
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

  // FASE 3: monta assentos, cria partida e distribui cartas
  function iniciarPartida(id) {
    const sala = salas[id];
    if (!sala || sala.partida) return;

    // pega os 2 primeiros humanos; assentos 0 e 1 (duplas opostas)
    const humanos = sala.jogadores.slice(0, 2);
    const modo = id.split(':')[2] || 'mineiro';

    // monta os 4 assentos: 0=humano A, 1=humano B, 2=bot, 3=bot
    const assentos = [
      { tipo: 'humano', id: humanos[0].id, nome: humanos[0].nome, socketId: humanos[0].socketId, pos: 0 },
      { tipo: 'humano', id: humanos[1].id, nome: humanos[1].nome, socketId: humanos[1].socketId, pos: 1 },
      { tipo: 'bot', nome: 'Bot Parceiro', pos: 2 },   // parceiro do humano A (dupla NOS)
      { tipo: 'bot', nome: 'Bot Adversario', pos: 3 }, // parceiro do humano B (dupla ELES)
    ];

    // cria a partida e a primeira mao usando a engine
    const P = engine.novaPartida(modo);
    engine.novaMao(P);

    sala.partida = { P, assentos };

    // info publica dos lugares (sem cartas): todos podem ver quem esta onde
    const lugares = assentos.map(a => ({
      pos: a.pos, tipo: a.tipo, nome: a.nome,
      dupla: (a.pos % 2 === 0) ? 'nos' : 'eles',
    }));

    // envia para cada HUMANO somente a mao dele (anti-trapaca)
    assentos.forEach(a => {
      if (a.tipo !== 'humano') return;
      io.to(a.socketId).emit('partida_iniciada', {
        sala: id,
        modo: P.modo,
        suaPos: a.pos,
        suaDupla: (a.pos % 2 === 0) ? 'nos' : 'eles',
        suaMao: P.mao.maos[a.pos],   // as 3 cartas SO deste jogador
        vira: P.mao.vira,
        manilha: P.mao.manilhaRank,
        vez: P.mao.vez,              // de quem e a vez de jogar
        lugares,
        placar: P.jogos,
      });
    });

    console.log(`🃏 Partida iniciada em ${id} (modo ${P.modo}) — cartas distribuidas`);
  }

  function sairDaSala(socket) {
    const id = socket.salaAtual;
    if (!id || !salas[id]) return;
    const sala = salas[id];
    sala.jogadores = sala.jogadores.filter(j => j.socketId !== socket.id);
    socket.leave(id);
    socket.salaAtual = null;

    // se uma partida estava rolando e um humano saiu, encerra a partida
    if (sala.partida) {
      io.to(id).emit('partida_encerrada', { motivo: 'um jogador saiu' });
      sala.partida = null;
    }

    io.to(id).emit('sala_atualizada', {
      sala: id,
      total: sala.jogadores.length,
      jogadores: sala.jogadores.map(j => ({ id: j.id, nome: j.nome })),
    });
    // limpa sala vazia
    if (sala.jogadores.length === 0) delete salas[id];
  }

  console.log('✅ Multiplayer (Fases 2+3) carregado');
};
