// ============================================================
// TrucoKing — Engine de Truco no SERVIDOR (Fase 1)
// Espelha fielmente a logica do frontend (truco-online.html).
//
// Esta engine NAO depende de navegador. Ela:
//   - monta e embaralha o baralho
//   - distribui as maos dos 4 jogadores
//   - calcula a forca das cartas (Mineiro e Paulista)
//   - decide quem ganha cada vaza
//   - controla o placar da mao, do jogo e o melhor-de-3
//   - valida as jogadas (e a vez de cada jogador)
//
// Duplas: NOS = posicoes [0,2], ELES = posicoes [1,3]
// Ordem de jogada: 0 -> 1 -> 2 -> 3
// ============================================================

'use strict';

const NAIPES = ['c', 'h', 's', 'd'];                 // paus, copas, espadas, ouros
const RANKS  = ['4','5','6','7','Q','J','K','A','2','3'];
// Forca base (sem manilha)
const FB = { '4':1,'5':2,'6':3,'7':4,'Q':5,'J':6,'K':7,'A':8,'2':9,'3':10 };
// Ordem para descobrir a manilha do Paulista a partir do "vira"
const RANK_CICLO = ['4','5','6','7','Q','J','K','A','2','3'];
// Niveis de aposta
const NIV_MIN = [2,4,6,8,10,12];
const NIV_PAU = [1,3,6,9,12];

// -------- Baralho --------
function buildDeck() {
  const d = [];
  for (const r of RANKS)
    for (const n of NAIPES)
      d.push({ r, n });
  return d;                                  // 40 cartas
}

// Embaralhamento Fisher-Yates (no servidor — fonte da verdade, sem trapaca)
function shuffle(deck) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// Proximo rank no ciclo (manilha do Paulista = rank seguinte ao do vira)
function nextRank(r) {
  return RANK_CICLO[(RANK_CICLO.indexOf(r) + 1) % RANK_CICLO.length];
}

// -------- Forca de uma carta --------
// modo: 'mineiro' | 'paulista' ; manilhaRank usado so no paulista
function forca(card, modo, manilhaRank) {
  if (!card) return 0;
  if (modo === 'mineiro') {
    if (card.r === '4' && card.n === 'c') return 14; // 4 de paus (zap)
    if (card.r === '7' && card.n === 'h') return 13; // 7 de copas
    if (card.r === 'A' && card.n === 's') return 12; // As de espadas
    if (card.r === '7' && card.n === 'd') return 11; // 7 de ouros
    return FB[card.r] || 1;
  }
  // paulista: manilha definida pelo vira
  if (manilhaRank && card.r === manilhaRank) {
    return ({ c:14, h:13, s:12, d:11 })[card.n] || 10;
  }
  return FB[card.r] || 1;
}

// -------- Distribuicao de uma nova mao --------
// Retorna o estado inicial da mao: maos[4], vira e manilhaRank (se paulista)
function distribuir(modo) {
  const deck = shuffle(buildDeck());
  let vira = null, manilhaRank = null, off = 0;

  if (modo === 'paulista') {
    vira = deck[0];
    manilhaRank = nextRank(vira.r);
    off = 1;                                  // primeira carta vira o "vira"
  }

  const maos = [
    [deck[off+0], deck[off+1], deck[off+2]],
    [deck[off+3], deck[off+4], deck[off+5]],
    [deck[off+6], deck[off+7], deck[off+8]],
    [deck[off+9], deck[off+10], deck[off+11]],
  ];

  return { maos, vira, manilhaRank };
}

// -------- Quem ganha a vaza --------
// played: array [c0,c1,c2,c3] (cartas jogadas nesta vaza, null se nao jogou)
// firstPos: quem abriu a vaza (desempate)
function quemGanhouVaza(played, modo, manilhaRank, firstPos) {
  const f = [
    forca(played[0], modo, manilhaRank),
    forca(played[1], modo, manilhaRank),
    forca(played[2], modo, manilhaRank),
    forca(played[3], modo, manilhaRank),
  ];
  const nos  = Math.max(f[0], f[2]);
  const eles = Math.max(f[1], f[3]);
  if (nos > eles)  return { dupla: 'nos',  pos: f[0] >= f[2] ? 0 : 2 };
  if (eles > nos)  return { dupla: 'eles', pos: f[1] >= f[3] ? 1 : 3 };
  return { dupla: 'emp', pos: firstPos };     // empate ("canga")
}

// ============================================================
// Estado de uma PARTIDA completa (melhor de 3 jogos, ate 12 pts cada)
// ============================================================
function novaPartida(modo) {
  return {
    modo: modo === 'paulista' ? 'paulista' : 'mineiro',
    jogos: { nos: 0, eles: 0 },     // jogos vencidos (melhor de 3)
    score: { nos: 0, eles: 0 },     // pontos do jogo atual
    maxPts: 12,
    firstPos: 0,                    // quem abre a mao
    valendo: modo === 'paulista' ? 1 : 2,  // valor atual da mao
    mao: null,                      // estado da mao em andamento
    finalizada: false,
    vencedor: null,                 // 'nos' | 'eles'
  };
}

// Inicia uma nova mao dentro da partida
function novaMao(P) {
  const { maos, vira, manilhaRank } = distribuir(P.modo);
  P.mao = {
    maos,                           // cartas de cada jogador (servidor conhece todas)
    vira,
    manilhaRank,
    played: [null, null, null, null],   // cartas na mesa da vaza atual
    vez: P.firstPos,                // de quem e a vez
    vazaFirst: P.firstPos,          // quem abriu a vaza atual
    vazaNum: 0,                     // 0,1,2
    vazaWins: { nos: 0, eles: 0 },  // vazas ganhas nesta mao
    primeiraVazaDupla: null,        // quem ganhou a 1a vaza (desempate)
    valendo: P.modo === 'paulista' ? 1 : 2,
    encerrada: false,
  };
  P.valendo = P.mao.valendo;
  return P.mao;
}

// Valida e aplica a jogada de uma carta
// pos: posicao do jogador (0..3); cardIdx: indice (0..2) na mao dele
// Retorna { ok, erro?, evento? }
function jogarCarta(P, pos, cardIdx) {
  const m = P.mao;
  if (!m || m.encerrada) return { ok: false, erro: 'Mao nao esta ativa' };
  if (pos !== m.vez)      return { ok: false, erro: 'Nao e a sua vez' };
  const carta = m.maos[pos][cardIdx];
  if (!carta)             return { ok: false, erro: 'Carta invalida' };

  // coloca a carta na mesa e remove da mao
  m.played[pos] = carta;
  m.maos[pos][cardIdx] = null;

  // passa a vez para o proximo (ordem 0->1->2->3)
  const jogaram = m.played.filter(Boolean).length;
  if (jogaram < 4) {
    m.vez = (m.vez + 1) % 4;
    return { ok: true, evento: 'carta_jogada', completaVaza: false };
  }

  // todos jogaram -> resolve a vaza
  const res = quemGanhouVaza(m.played, P.modo, m.manilhaRank, m.vazaFirst);
  if (res.dupla !== 'emp') {
    m.vazaWins[res.dupla]++;
    if (m.vazaNum === 0) m.primeiraVazaDupla = res.dupla;
  }
  const vazaResultado = { ...res, vaza: m.vazaNum };

  // prepara proxima vaza ou encerra a mao
  m.vazaNum++;
  m.played = [null, null, null, null];
  m.vazaFirst = res.dupla === 'emp' ? m.vazaFirst : res.pos;
  m.vez = m.vazaFirst;

  const fim = checarFimDaMao(P);
  return { ok: true, evento: 'fim_de_vaza', vaza: vazaResultado, fimDaMao: fim };
}

// Decide se a mao acabou (2 vazas ou regra de empate) e pontua
function checarFimDaMao(P) {
  const m = P.mao;
  const w = m.vazaWins;

  let vencedorMao = null;
  // venceu quem fez 2 vazas
  if (w.nos >= 2) vencedorMao = 'nos';
  else if (w.eles >= 2) vencedorMao = 'eles';
  // apos 3 vazas, resolve por empate (quem fez a primeira)
  else if (m.vazaNum >= 3) {
    if (w.nos > w.eles) vencedorMao = 'nos';
    else if (w.eles > w.nos) vencedorMao = 'eles';
    else vencedorMao = m.primeiraVazaDupla || 'nos';
  }
  if (!vencedorMao) return null;

  m.encerrada = true;
  P.score[vencedorMao] += m.valendo;

  // fim do jogo?
  let fimJogo = null;
  if (P.score[vencedorMao] >= P.maxPts) {
    P.jogos[vencedorMao]++;
    P.score = { nos: 0, eles: 0 };
    if (P.jogos[vencedorMao] >= 2) {
      P.finalizada = true;
      P.vencedor = vencedorMao;
      fimJogo = { tipo: 'partida', vencedor: vencedorMao };
    } else {
      fimJogo = { tipo: 'jogo', vencedor: vencedorMao };
    }
  }

  // alterna quem abre a proxima mao
  P.firstPos = (P.firstPos + 1) % 4;
  return { vencedorMao, pontos: m.valendo, fimJogo };
}

// Pedido de truco/aumento. Retorna o novo valor proposto, conforme o modo.
function proximoValor(P) {
  const nivs = P.modo === 'mineiro' ? NIV_MIN : NIV_PAU;
  const atual = P.mao ? P.mao.valendo : nivs[0];
  const i = nivs.indexOf(atual);
  if (i < 0) return nivs[1] || atual;
  return nivs[Math.min(i + 1, nivs.length - 1)];
}

module.exports = {
  NAIPES, RANKS, FB, NIV_MIN, NIV_PAU,
  buildDeck, shuffle, nextRank, forca, distribuir,
  quemGanhouVaza, novaPartida, novaMao, jogarCarta,
  checarFimDaMao, proximoValor,
};
