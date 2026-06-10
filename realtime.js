// ============================================================
// TrucoKing — Multiplayer em tempo real (Fases 2 + 3 + 4)
//
// Fase 2: conexao, autenticacao e SALAS.
// Fase 3: com 2 humanos, monta assentos, cria partida e distribui cartas.
// Fase 4: recebe a jogada do humano (jogar_carta), valida pela engine,
//   transmite o resultado, e faz os BOTS jogarem na vez deles.
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

    // FASE 4: humano joga uma carta
    socket.on('jogar_carta', ({ cardIdx }) => {
      const id = socket.salaAtual;
      if (!id || !salas[id] || !salas[id].partida) return;
      const { assentos } = salas[id].partida;
      // descobre a posicao (assento) deste jogador
      const meu = assentos.find(a => a.tipo === 'humano' && a.id === socket.user.id);
      if (!meu) return;
      const r = aplicarJogada(id, meu.pos, cardIdx);
      if (r && !r.ok) {
        socket.emit('jogada_recusada', { erro: r.erro });
      }
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

    // se a vez ja comeca num bot, ele joga
    setTimeout(() => jogarBotSeForVez(id), 1200);
  }

  // monta o estado PUBLICO da mesa (sem revelar as maos dos jogadores)
  function estadoPublico(sala) {
    const { P } = sala.partida;
    const m = P.mao;
    return {
      played: m.played,        // cartas na mesa (visiveis a todos)
      vez: m ? m.vez : null,
      vazaNum: m ? m.vazaNum : 0,
      placar: P.jogos,
      score: P.score,
      valendo: P.valendo,
      finalizada: P.finalizada,
      vencedor: P.vencedor,
    };
  }

  // aplica uma jogada (de humano ou bot) e transmite o resultado
  function aplicarJogada(id, pos, cardIdx) {
    const sala = salas[id];
    if (!sala || !sala.partida) return;
    const { P } = sala.partida;

    const r = engine.jogarCarta(P, pos, cardIdx);
    if (!r.ok) return r; // jogada invalida (ex: nao era a vez)

    // avisa todos: alguem jogou uma carta
    io.to(id).emit('jogada_feita', {
      pos,
      evento: r.evento,
      vaza: r.vaza || null,
      fimDaMao: r.fimDaMao || null,
      estado: estadoPublico(sala),
    });

    // fim da mao? inicia a proxima (se a partida nao acabou)
    if (r.fimDaMao) {
      if (P.finalizada) {
        io.to(id).emit('partida_finalizada', { vencedor: P.vencedor, placar: P.jogos });
        sala.partida = null;
        return r;
      }
      // nova mao apos um respiro
      setTimeout(() => {
        engine.novaMao(P);
        // reenvia as novas maos privadas para cada humano
        sala.partida.assentos.forEach(a => {
          if (a.tipo !== 'humano') return;
          io.to(a.socketId).emit('nova_mao', {
            suaMao: P.mao.maos[a.pos],
            vira: P.mao.vira,
            manilha: P.mao.manilhaRank,
            vez: P.mao.vez,
            estado: estadoPublico(sala),
          });
        });
        setTimeout(() => jogarBotSeForVez(id), 1200);
      }, 2500);
      return r;
    }

    // senao, checa se a proxima vez e de um bot
    setTimeout(() => jogarBotSeForVez(id), 1000);
    return r;
  }

  // se a vez atual for de um bot, ele escolhe uma carta e joga
  function jogarBotSeForVez(id) {
    const sala = salas[id];
    if (!sala || !sala.partida) return;
    const { P, assentos } = sala.partida;
    const m = P.mao;
    if (!m || m.encerrada) return;

    const assento = assentos.find(a => a.pos === m.vez);
    if (!assento || assento.tipo !== 'bot') return; // nao e vez de bot

    const cardIdx = escolherCartaBot(P, m.vez);
    if (cardIdx < 0) return;

    aplicarJogada(id, m.vez, cardIdx);
  }

  // Estrategia do bot "esperto o suficiente":
  // - se PODE ganhar a vaza: joga a MENOR carta que ainda vence (nao gasta manilha a toa)
  // - se NAO da pra ganhar: descarta a carta mais FRACA (guarda as boas)
  // - se esta ABRINDO a vaza: joga uma carta mediana (nem a melhor, nem a pior)
  function escolherCartaBot(P, pos) {
    const m = P.mao;
    const modo = P.modo, manilha = m.manilhaRank;
    // cartas disponiveis na mao do bot, com indice e forca
    const cartas = m.maos[pos]
      .map((c, idx) => ({ idx, card: c, f: engine.forca(c, modo, manilha) }))
      .filter(x => x.card !== null);
    if (cartas.length === 0) return -1;
    cartas.sort((a, b) => a.f - b.f); // da mais fraca para a mais forte

    // qual a maior forca que o adversario ja botou na mesa nesta vaza?
    const ehAdversario = (p) => (p % 2) !== (pos % 2);
    let maxAdv = 0;
    m.played.forEach((c, p) => {
      if (c && ehAdversario(p)) {
        const fc = engine.forca(c, modo, manilha);
        if (fc > maxAdv) maxAdv = fc;
      }
    });

    // o parceiro ja esta ganhando a vaza? entao economiza (descarta a mais fraca)
    let maxParceiro = 0;
    m.played.forEach((c, p) => {
      if (c && !ehAdversario(p) && p !== pos) {
        const fc = engine.forca(c, modo, manilha);
        if (fc > maxParceiro) maxParceiro = fc;
      }
    });
    if (maxParceiro > 0 && maxParceiro >= maxAdv) {
      return cartas[0].idx; // parceiro ja ganha: joga a mais fraca
    }

    // abrindo a vaza (ninguem jogou ainda): carta mediana
    const alguemJogou = m.played.some(c => c !== null);
    if (!alguemJogou) {
      const mid = Math.floor(cartas.length / 2);
      return cartas[mid].idx;
    }

    // tenta ganhar: menor carta que supera o adversario
    const vencedora = cartas.find(x => x.f > maxAdv);
    if (vencedora) return vencedora.idx;

    // nao da pra ganhar: descarta a mais fraca
    return cartas[0].idx;
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

  console.log('✅ Multiplayer (Fases 2+3+4) carregado');
};
