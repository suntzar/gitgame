const express = require('express');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const http = require('http');
const fs = require('fs');
// const { Z_ASCII } = require('zlib'); // Z_ASCII não é necessário aqui, remover se não usar

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server, {
    // Opções do Socket.IO, se necessário (ex: cors)
    // cors: { origin: "*" }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Configurações ---
const MIN_PLAYERS_TO_START = 2; // Mínimo de jogadores para iniciar
const TURN_TIME = 60; // segundos por turno
const LEVEL_TRANSITION_PAUSE = 4000; // ms de pausa entre níveis
const EXEC_TIMEOUT = 5000; // ms de timeout para execução de código Python

// --- Carregamento de Níveis ---
let levels;
try {
    levels = JSON.parse(fs.readFileSync('levels.json', 'utf8')).levels;
    console.log("✅ Níveis carregados com sucesso.");
} catch (err) {
    console.error("❌ Erro fatal ao carregar levels.json:", err);
    process.exit(1);
}

// --- Estado Global do Jogo ---
let gameState = 'LOBBY'; // LOBBY, PLAYING, LEVEL_COMPLETE, GAME_OVER
let players = {}; // Mapa: { socketId: { id, nickname, isReady, isSpectator } }
let playerConnectionOrder = []; // Ordem de conexão para determinar próximo host
let playerOrder = []; // Ordem dos turnos dos jogadores ATIVOS na partida/nível
let hostId = null; // ID do socket do Host da partida
let currentLevelIndex = 0;
let currentLevel = null; // Objeto do nível atual
let currentCode = ""; // Código colaborativo atual
let levelStartTime = null; // Timestamp de início do nível atual
let chosenInputForLevel = null; // Input escolhido para o nível atual (se aplicável)
let chosenOutputForLevel = null; // Output esperado para o input escolhido (se aplicável)

// --- Lógica de Turnos e Cronômetros ---
let currentTurnIndex = 0; // Índice em playerOrder
let turnStartTime = null; // Timestamp de início do turno atual
let turnInterval = null; // Referência para setInterval do timer do turno
let turnTimerRemaining = TURN_TIME; // Tempo restante no turno atual

// --- Funções Principais ---

/** Envia o estado atualizado do jogo para TODOS os clientes conectados. */
function broadcastGameState() {
    // Determina quem são os espectadores com base no estado e na ordem de turno
    const playersList = Object.values(players).map(p => ({
        ...p,
        // É espectador se o jogo está rodando e ele não está na ordem de turno ATIVA
        isSpectator: (gameState === 'PLAYING' || gameState === 'LEVEL_COMPLETE') && !playerOrder.includes(p.id)
    }));

    const state = {
        gameState,
        players: playersList, // Envia lista com status isSpectator
        hostId, // Envia ID do host atual
        playerOrder, // Envia a ordem de turno atual (dos jogadores ativos)
        currentTurnIndex: (gameState === 'PLAYING' && playerOrder.length > 0) ? currentTurnIndex : 0,
        currentLevel: gameState !== 'LOBBY' ? currentLevel : null,
        currentCode: gameState !== 'LOBBY' ? currentCode : "",
        chosenInput: gameState !== 'LOBBY' ? chosenInputForLevel : null,
        chosenExpectedOutput: gameState !== 'LOBBY' ? chosenOutputForLevel : null,
        turnTimerRemaining: (gameState === 'PLAYING' && turnInterval) ? turnTimerRemaining : TURN_TIME, // Envia tempo restante real se o timer estiver rodando
        levelStartTime // Timestamp para cálculos no cliente, se necessário
    };
    io.emit('gameStateUpdate', state);
    // console.log(`📢 Estado (${gameState}) enviado para ${Object.keys(players).length} jogadores. Host: ${hostId}`);
}

/** Promove o próximo jogador elegível (na ordem de conexão) a host. */
function promoteNextHost() {
    if (hostId && players[hostId]) return; // Host atual ainda está conectado

    let newHostFound = false;
    for (const playerId of playerConnectionOrder) {
        if (players[playerId]) { // Encontra o primeiro na ordem que ainda está conectado
            hostId = playerId;
            newHostFound = true;
            console.log(`👑 Host migrado para: ${players[hostId]?.nickname || 'ID:'+hostId}`);
            io.emit('feedback', { type: 'info', title: 'Mudança de Host', message: `${players[hostId]?.nickname || 'Um jogador'} agora é o host.` });
            break;
        }
    }

    if (!newHostFound) {
        hostId = null;
        console.log("📉 Nenhum jogador restante para ser host.");
        if (gameState !== 'LOBBY' && Object.keys(players).length === 0) {
            resetGameToLobby("Host saiu e não há outros jogadores.");
        }
    }
    // Mesmo se não houver novo host, atualiza o estado (hostId será null)
    broadcastGameState();
}

/** Inicia o jogo a partir do Lobby. */
function startGame() {
    const allPlayers = Object.values(players);
    const readyPlayers = allPlayers.filter(p => p.isReady);

    if (gameState !== 'LOBBY' || !hostId) {
        console.warn("⚠️ Tentativa de iniciar jogo fora do lobby ou sem host.");
        return;
    }
    if (readyPlayers.length < MIN_PLAYERS_TO_START) {
         console.log(`🏁 Tentativa de iniciar jogo sem jogadores prontos suficientes (${readyPlayers.length}/${MIN_PLAYERS_TO_START}).`);
         io.to(hostId).emit('actionError', `Precisa de pelo menos ${MIN_PLAYERS_TO_START} jogadores prontos para iniciar.`);
        return;
    }
     if (readyPlayers.length !== allPlayers.length) {
         console.log(`🏁 Tentativa de iniciar jogo, mas nem todos estão prontos (${readyPlayers.length}/${allPlayers.length}).`);
          io.to(hostId).emit('actionError', `Aguardando todos os ${allPlayers.length} jogadores marcarem como prontos.`);
         return; // Garante que TODOS estejam prontos
     }


    console.log("🚀 Iniciando Jogo!");
    gameState = 'PLAYING';

    // Define a ordem de turno INICIAL apenas com jogadores que estavam prontos no lobby
    playerOrder = playerConnectionOrder.filter(id => players[id]?.isReady);

    // Marca quem NÃO estava pronto como espectador inicial
    Object.values(players).forEach(p => {
        p.isSpectator = !playerOrder.includes(p.id);
        if(p.isSpectator) console.log(`👓 ${p.nickname} inicia como espectador.`);
    });

    currentLevelIndex = 0;
    currentTurnIndex = 0; // Começa com o primeiro jogador na ordem definida
    currentCode = ""; // Limpa código anterior

    loadLevel(currentLevelIndex); // Carrega o primeiro nível
    startTurn(); // Inicia o primeiro turno
    // broadcastGameState(); // loadLevel e startTurn já chamam broadcast
}

/** Carrega um nível específico, escolhe input/output e integra espectadores se necessário. */
function loadLevel(index) {
    if (index >= levels.length) {
        gameOver("Todos os níveis foram completados!");
        return false; // Indica que o jogo acabou
    }

    console.log(`🧩 Carregando nível ${index + 1}/${levels.length}...`);
    currentLevel = levels[index];
    currentCode = currentLevel.initialCode || ""; // Usa código inicial se definido
    chosenInputForLevel = null;
    chosenOutputForLevel = null;

    // Se o nível usa inputs, escolhe um par aleatório
    if (currentLevel.inputs && currentLevel.inputs.length > 0) {
        const idx = Math.floor(Math.random() * currentLevel.inputs.length);
        chosenInputForLevel = currentLevel.inputs[idx];
        // Garante que expectedOutputs exista e tenha o índice correspondente
        chosenOutputForLevel = currentLevel.expectedOutputs?.[idx];
        if (chosenOutputForLevel === undefined) {
            console.error(`❌ Erro crítico no levels.json: Nível ${currentLevel.id} tem input ${idx} mas não tem expectedOutput correspondente!`);
             // Poderia tentar escolher outro input ou falhar
             // Por segurança, vamos usar um valor padrão ou o último output
             chosenOutputForLevel = currentLevel.expectedOutputs?.[currentLevel.expectedOutputs.length - 1] ?? null;
        }
        console.log(`   Input escolhido: ${JSON.stringify(chosenInputForLevel)}, Output esperado: ${JSON.stringify(chosenOutputForLevel)}`);
    } else {
        console.log(`   Output esperado direto: ${JSON.stringify(currentLevel.expectedValue)}`);
    }
    levelStartTime = Date.now(); // Reinicia cronômetro do nível

    // *** Integração de Espectadores ao iniciar um NOVO nível (exceto o primeiro) ***
    const connectedPlayerIds = Object.keys(players);
    if (gameState === 'PLAYING' && connectedPlayerIds.length > 0) { // Verifica se há jogadores conectados
        console.log("   Verificando integração de jogadores...");
        // Reconstrói a ordem do turno com TODOS os jogadores conectados naquele momento
        // Usa playerConnectionOrder para manter uma ordem consistente
        const activePlayersNow = playerConnectionOrder.filter(id => players[id]);
        if (activePlayersNow.length > 0) {
            const oldPlayerOrder = [...playerOrder];
            playerOrder = [...activePlayersNow]; // Define a nova ordem ATIVA
             // Marca todos na nova ordem como NÃO espectadores
            playerOrder.forEach(id => {
                if (players[id]) players[id].isSpectator = false;
            });
            console.log(`   Jogadores ativos agora (${playerOrder.length}): ${playerOrder.map(id => players[id]?.nickname).join(', ')}`);

            // Reinicia o índice do turno para o primeiro jogador da nova ordem
            currentTurnIndex = 0;
        } else {
             console.warn("⚠️ Tentativa de carregar nível sem jogadores ativos. Resetando para Lobby.");
             resetGameToLobby("Nenhum jogador ativo ao iniciar o nível.");
             return false; // Indica falha ao carregar
        }
    } else if (gameState === 'LOBBY' && index === 0) {
         // No início do jogo (index 0 vindo do lobby), playerOrder já foi definido em startGame
         console.log(`   Ordem inicial definida: ${playerOrder.map(id => players[id]?.nickname).join(', ')}`);
    }


    broadcastGameState(); // Envia o estado com o novo nível carregado
    return true; // Indica sucesso
}

/** Envia o tempo restante do turno a cada segundo. Passa o turno se o tempo acabar. */
function broadcastTurnTimer() {
    if (gameState !== 'PLAYING' || !turnStartTime) return; // Só roda se estiver jogando e turno iniciado

    const elapsed = Math.floor((Date.now() - turnStartTime) / 1000);
    turnTimerRemaining = Math.max(0, TURN_TIME - elapsed);
    // Envia apenas o tempo restante para otimizar
    io.emit('turnTimerUpdate', turnTimerRemaining);

    if (turnTimerRemaining <= 0) {
        const currentPlayerNickname = players[playerOrder[currentTurnIndex]]?.nickname || `Jogador ${currentTurnIndex + 1}`;
        console.log(`⏳ Tempo esgotado para ${currentPlayerNickname}. Próximo turno.`);
        io.emit('feedback', { type: 'warning', message: `Tempo esgotado para ${currentPlayerNickname}. Passando a vez.` });
        nextTurn();
    }
}

/** Inicia o turno do jogador atual na `playerOrder`. */
function startTurn() {
    if (gameState !== 'PLAYING' || playerOrder.length === 0) {
        if (turnInterval) clearInterval(turnInterval);
        turnInterval = null;
        console.warn("⚠️ Tentativa de iniciar turno sem jogadores ativos ou fora do estado PLAYING.");
        // Se não há jogadores, deveria voltar ao Lobby? A desconexão já trata isso.
        if (playerOrder.length === 0 && gameState === 'PLAYING'){
             resetGameToLobby("Nenhum jogador ativo para iniciar o turno.");
        }
        return;
    }

    // Garante que o índice seja válido após remoções/adições
    currentTurnIndex = currentTurnIndex % playerOrder.length;
    const currentTurnID = playerOrder[currentTurnIndex];
    const currentPlayer = players[currentTurnID];

    if (!currentPlayer) {
        console.error(`❌ Jogador ${currentTurnID} (índice ${currentTurnIndex}) não encontrado no mapa 'players' ao iniciar turno! Tentando próximo.`);
        // Isso pode ocorrer em uma race condition rara. Tenta avançar.
        nextTurn(); // Cuidado com loop infinito se playerOrder estiver inconsistente
        return;
    }

    turnStartTime = Date.now();
    turnTimerRemaining = TURN_TIME; // Reseta o tempo para o novo turno
    console.log(`▶️ Turno ${currentTurnIndex + 1}/${playerOrder.length} para ${currentPlayer.nickname} (ID: ${currentTurnID})`);

    // Limpa intervalo antigo e inicia novo
    if (turnInterval) clearInterval(turnInterval);
    turnInterval = setInterval(broadcastTurnTimer, 1000);

    // Envia atualização de quem é a vez e o estado geral
    io.emit('turnUpdate', { currentTurnID, nickname: currentPlayer.nickname });
    broadcastGameState(); // Garante que todos tenham o estado mais recente
}

/** Passa a vez para o próximo jogador na `playerOrder`. */
function nextTurn() {
    if (gameState !== 'PLAYING' || playerOrder.length === 0) {
        console.warn("⚠️ Tentativa de passar o turno sem jogadores ativos ou fora do estado PLAYING.");
        if (turnInterval) clearInterval(turnInterval);
        turnInterval = null;
        return;
    }
    // Avança o índice, dando a volta se necessário
    currentTurnIndex = (currentTurnIndex + 1) % playerOrder.length;
    console.log(`⏩ Próximo turno. Novo índice: ${currentTurnIndex}`);
    startTurn(); // Inicia o turno do próximo jogador
}

/** Finaliza o jogo (todos os níveis completos). */
function gameOver(message) {
    console.log("🎉 Jogo Finalizado:", message);
    gameState = 'GAME_OVER';
    if (turnInterval) clearInterval(turnInterval);
    turnInterval = null;
    playerOrder = []; // Limpa ordem de turno ativa
    // Marca todos como não prontos e não espectadores para o próximo jogo
    Object.values(players).forEach(p => {
        p.isReady = false;
        p.isSpectator = false;
    });
    io.emit('gameComplete', message); // Evento específico para o fim
    broadcastGameState(); // Atualiza o estado geral para GAME_OVER
}

/** Reseta o jogo para o estado de Lobby. */
function resetGameToLobby(reason = "Jogo resetado.") {
     console.log(`🔄 Resetando jogo para LOBBY. Razão: ${reason}`);
     gameState = 'LOBBY';
     if (turnInterval) clearInterval(turnInterval);
     turnInterval = null;
     playerOrder = []; // Limpa ordem de turno ativa
     currentLevelIndex = 0;
     currentLevel = null;
     currentCode = "";
     levelStartTime = null;
     chosenInputForLevel = null;
     chosenOutputForLevel = null;
     // Mantém hostId, mas reseta status de todos
     Object.values(players).forEach(p => {
         p.isReady = false;
         p.isSpectator = false; // Limpa status de espectador
     });
     // Garante que haja um host, se possível
     if (!hostId && playerConnectionOrder.length > 0) {
         promoteNextHost(); // Tenta definir um host se não houver
     }
     broadcastGameState(); // Envia estado de Lobby limpo
}

/** Verifica se o output do código corresponde ao esperado, considerando o tipo. */
function verifyOutput(output, expectedType, expectedValue) {
    const outputStr = String(output).trim();
    const expectedStr = String(expectedValue).trim(); // Compara como string também

    try {
        if (expectedType === "number") {
            const numOut = parseFloat(outputStr);
            const numExp = parseFloat(expectedStr);
            if (isNaN(numOut) || isNaN(numExp)) return false;
            // Comparação com tolerância para floats, ou exata para inteiros
            return Math.abs(numOut - numExp) < 0.0001;
        } else if (expectedType === "boolean") {
            const boolOut = outputStr.toLowerCase();
            const boolExp = expectedStr.toLowerCase();
            // Aceita 'true'/'false' ou 'True'/'False' (Python output)
             return (boolExp === "true" && (boolOut === "true")) ||
                    (boolExp === "false" && (boolOut === "false"));
        } else if (expectedType === "string") {
             // Comparação exata para strings, após trim()
             // Importante: Python print() pode adicionar newline, stdout.trim() remove.
             return outputStr === expectedStr;
        } else {
             // Fallback para outros tipos (ou se tipo não especificado)
             return outputStr === expectedStr;
        }
    } catch (e) {
        console.error("Erro durante verifyOutput:", e);
        return false;
    }
}


// --- Socket.io Event Handlers ---
io.on('connection', socket => {
    const playerIP = socket.handshake.address || socket.conn.remoteAddress;
    console.log(`🔌 Novo cliente conectado: ${socket.id} (IP: ${playerIP})`);

    // Cria o objeto do jogador
    const playerNickname = `Jogador_${socket.id.substring(0, 4)}`;
    players[socket.id] = {
        id: socket.id,
        nickname: playerNickname,
        isReady: false,
        // Se entrar durante PLAYING ou LEVEL_COMPLETE, começa como espectador
        isSpectator: (gameState === 'PLAYING' || gameState === 'LEVEL_COMPLETE')
    };
    playerConnectionOrder.push(socket.id); // Adiciona à ordem de conexão geral
    console.log(`👤 Jogador ${playerNickname} (ID: ${socket.id}) entrou.` + (players[socket.id].isSpectator ? ' [ESPECTADOR]' : ''));

    // Define Host se for o primeiro jogador a conectar
    if (hostId === null) {
        hostId = socket.id;
        console.log(`👑 ${playerNickname} (ID: ${hostId}) é o novo Host.`);
    }

    // Envia informações de ID/Nick para o novo jogador
    socket.emit('yourInfo', { id: socket.id, nickname: playerNickname });
    // Envia o estado atual completo para TODOS (incluindo o novo jogador e o status de espectador)
    broadcastGameState();
    // Envia mensagem de boas-vindas/status
    if (players[socket.id].isSpectator) {
         socket.emit('feedback', {type: 'info', title: 'Modo Espectador', message: 'Você entrou em um jogo em andamento. Você poderá jogar no próximo nível.'});
    } else if (gameState === 'LOBBY'){
         socket.emit('feedback', {type: 'info', title: 'Bem-vindo ao Lobby!', message: 'Defina seu apelido e marque "Pronto" quando estiver preparado.'});
    }


    // ---- Eventos do Cliente ----

    socket.on('setNickname', (newNickname) => {
        const sanitizedNickname = String(newNickname || "").trim().substring(0, 20);
        if (!sanitizedNickname) return socket.emit('actionError', 'Apelido inválido.');
        if (!players[socket.id]) return; // Jogador já desconectou?

        // Opcional: Verificar apelido duplicado
        // const isDuplicate = Object.values(players).some(p => p.nickname === sanitizedNickname && p.id !== socket.id);
        // if (isDuplicate) return socket.emit('actionError', 'Este apelido já está em uso.');

        const oldNickname = players[socket.id].nickname;
        players[socket.id].nickname = sanitizedNickname;
        console.log(`🏷️ Apelido alterado: ${oldNickname} -> ${sanitizedNickname} (ID: ${socket.id})`);
        broadcastGameState(); // Atualiza a lista para todos
        socket.emit('feedback', {type: 'success', message: `Apelido definido como: ${sanitizedNickname}`});
    });

    socket.on('toggleReady', () => {
        if (gameState !== 'LOBBY' || !players[socket.id]) return; // Só no Lobby e se conectado

         // Espectadores não podem marcar pronto (embora não devessem estar no lobby)
         if (players[socket.id].isSpectator) return socket.emit('actionError', 'Espectadores não podem alterar o status de pronto.');

        players[socket.id].isReady = !players[socket.id].isReady;
        console.log(`✅ Jogador ${players[socket.id].nickname} ${players[socket.id].isReady ? 'está pronto' : 'não está pronto'}.`);
        broadcastGameState(); // Atualiza lista e status do lobby

        // Verifica se PODE iniciar automaticamente AGORA
        const allPlayers = Object.values(players).filter(p => !p.isSpectator); // Apenas jogadores não-espectadores contam para iniciar
        const readyPlayers = allPlayers.filter(p => p.isReady);
         if (allPlayers.length >= MIN_PLAYERS_TO_START && readyPlayers.length === allPlayers.length && hostId) {
              console.log("🏁 Todos os jogadores ativos estão prontos! Iniciando jogo...");
              startGame();
         } else {
              console.log(`📊 Status de prontidão: ${readyPlayers.length}/${allPlayers.length} (mínimo ${MIN_PLAYERS_TO_START})`);
         }
    });

    socket.on('codeUpdate', (newCode) => {
        const player = players[socket.id];
        if (!player || player.isSpectator || gameState !== 'PLAYING' || playerOrder.length === 0) return;

        // Só o jogador da vez pode editar
        if (socket.id === playerOrder[currentTurnIndex]) {
            // Opcional: Validar/Sanitizar 'newCode' aqui se necessário
            if (currentCode !== newCode) {
                 currentCode = newCode;
                 // Transmite a mudança para os outros jogadores (incluindo espectadores)
                 socket.broadcast.emit('codeUpdate', currentCode);
            }
        } else {
             console.warn(`⚠️ ${player.nickname} tentou editar código fora da sua vez.`);
             socket.emit('actionError', 'Não é sua vez de editar!');
        }
    });

    socket.on('passTurn', () => {
        const player = players[socket.id];
        if (!player || player.isSpectator || gameState !== 'PLAYING' || playerOrder.length === 0) return;

        if (socket.id === playerOrder[currentTurnIndex]) {
            console.log(`🙋 ${player.nickname} passou a vez.`);
            io.emit('feedback', { type: 'info', message: `${player.nickname} passou a vez.` });
            nextTurn();
        } else {
            socket.emit('actionError', 'Você não pode passar a vez agora.');
        }
    });

    // Reset do NÍVEL ATUAL (Apenas Host)
    socket.on('resetLevel', () => {
        if (socket.id !== hostId) return socket.emit('actionError', 'Apenas o Host pode resetar o nível.');
        if (gameState !== 'PLAYING') return socket.emit('actionError', 'Só é possível resetar o nível durante o jogo.');
        if (!currentLevel) return socket.emit('actionError', 'Nenhum nível carregado para resetar.');

        console.log(`🔄 Nível ${currentLevel.id} resetado pelo Host ${players[socket.id]?.nickname}.`);
        currentCode = currentLevel.initialCode || "";
        levelStartTime = Date.now(); // Reinicia cronômetro do nível
        // Resetar cronômetro do TURNO atual também?
        // turnStartTime = Date.now();
        // turnTimerRemaining = TURN_TIME;
        broadcastGameState(); // Envia estado com código resetado
        io.emit('codeUpdate', currentCode); // Força atualização do editor
        io.emit('feedback', { type: 'warning', title: 'Nível Resetado', message: `O nível foi resetado pelo Host.` });
        // Poderia reiniciar o timer do turno atual
        // if(turnInterval) clearInterval(turnInterval);
        // turnInterval = setInterval(broadcastTurnTimer, 1000);
    });

    // Forçar volta ao Lobby (Apenas Host)
    socket.on('forceResetToLobby', () => {
        if (socket.id !== hostId) return socket.emit('actionError', 'Apenas o Host pode forçar a volta ao Lobby.');

        const nickname = players[socket.id]?.nickname || 'Host';
        console.log(`🚪 Host ${nickname} forçou o retorno ao Lobby.`);
        const reason = `Retorno ao Lobby forçado pelo Host (${nickname}).`;
        io.emit('feedback', { type: 'warning', title: 'Jogo Resetado', message: reason });
        resetGameToLobby(reason); // Executa o reset
    });

    // Kick Player (Apenas Host)
    socket.on('kickPlayer', (targetId) => {
        if (socket.id !== hostId) return socket.emit('actionError', 'Apenas o Host pode remover jogadores.');
        if (targetId === hostId) return socket.emit('actionError', 'O Host não pode se remover.');

        const targetPlayer = players[targetId];
        const targetSocket = io.sockets.sockets.get(targetId); // Pega o objeto socket do alvo

        if (targetPlayer && targetSocket) {
            const kickerNickname = players[hostId]?.nickname || 'Host';
            const targetNickname = targetPlayer.nickname;
            console.log(`🚫 Host ${kickerNickname} removeu ${targetNickname} (ID: ${targetId})`);

            // Notifica o jogador removido ANTES de desconectar
            targetSocket.emit('kicked', `Você foi removido da partida pelo Host (${kickerNickname}).`);
            // Força desconexão do alvo (isso disparará o evento 'disconnect' para limpeza)
            targetSocket.disconnect(true);

            // Notifica os outros jogadores
            io.emit('feedback', { type: 'warning', title: 'Jogador Removido', message: `${targetNickname} foi removido pelo Host.` });
            // Não precisa chamar broadcastGameState aqui, o 'disconnect' fará isso.
        } else {
             socket.emit('actionError', 'Jogador alvo não encontrado ou já desconectado.');
             console.warn(`⚠️ Tentativa de kick em ${targetId} falhou (jogador não encontrado).`);
        }
    });

    // Submissão do código (Apenas jogadores ativos)
    socket.on('submitCode', () => {
        const player = players[socket.id];
        if (!player) return; // Saiu?
        if (gameState !== 'PLAYING') return socket.emit('submissionResult', { success: false, message: "O jogo não está em andamento." });
        if (player.isSpectator) return socket.emit('submissionResult', { success: false, message: "Espectadores não podem submeter código." });
        if (!currentLevel) return socket.emit('submissionResult', { success: false, message: "Erro interno: Nível atual não carregado." });

        console.log(`📤 Jogador ${player.nickname} submeteu código para o Nível ${currentLevel.id}`);
        io.emit('feedback', { type: 'info', message: `${player.nickname} submeteu uma solução...` });

        let codeToRun = currentCode;
        const tempFile = path.join(__dirname, `temp_${uuidv4()}.py`); // Usar path.join para compatibilidade
        let runCommand = `python3 "${tempFile}"`; // Usar aspas no path para lidar com espaços

        // Adiciona a chamada da função init ou main, se aplicável
        let requiresInitCall = false;
        if (currentLevel.inputs && currentLevel.inputs.length > 0) {
             requiresInitCall = true;
             if (chosenInputForLevel === null || chosenInputForLevel === undefined) {
                 console.error("❌ Erro crítico: Nível requer input, mas 'chosenInputForLevel' é nulo.");
                 return socket.emit('submissionResult', { success: false, message: "Erro interno do servidor: Input não definido para este teste." });
             }
             // Formata os argumentos corretamente (strings precisam de aspas literais)
             const args = chosenInputForLevel.map(arg =>
                 typeof arg === 'string' ? `'${arg.replace(/'/g, "\\'")}'` : // Usa aspas simples para Python
                 (arg === null ? 'None' : // Converte null JS para None Python
                 (typeof arg === 'boolean' ? (arg ? 'True' : 'False') : arg)) // Converte boolean JS para Python
             ).join(", ");
             codeToRun += `\n\n# --- Server Appended --- \ntry:\n  print(init(${args}))\nexcept NameError:\n  print("Erro: Funcao 'init' nao definida.")\nexcept Exception as e:\n  print(f"Erro na execucao de init: {e}")`;
             console.log(`🐍 Executando com input: init(${args})`);

        } else if (!currentLevel.expectedValue && currentLevel.command && currentLevel.command.toLowerCase().includes("main()")) {
             // Se não tem valor esperado direto E o comando menciona main(), assume que main() deve ser chamada
             codeToRun += `\n\n# --- Server Appended --- \nif __name__ == "__main__":\n  try:\n    main()\n  except NameError:\n    print("Erro: Funcao 'main' nao definida.")\n  except Exception as e:\n    print(f"Erro na execucao de main: {e}")`;
             console.log(`🐍 Executando main() esperado.`);
        } else {
             // Caso simples (como Nível 1) onde o próprio código deve gerar o output esperado
             // Ou níveis onde init() não é explicitamente chamada, mas o código a usa internamente?
             // Se for Nível 1, o usuário deve escrever `print(...)`
             console.log(`🐍 Executando código diretamente (espera output direto).`);
        }

        console.log(`💾 Código a ser executado em ${tempFile}:\n---\n${codeToRun}\n---`);

        fs.writeFile(tempFile, codeToRun, (writeErr) => {
            if (writeErr) {
                console.error("❌ Erro ao escrever arquivo temporário:", writeErr);
                return socket.emit('submissionResult', { success: false, message: "Erro interno do servidor ao preparar execução." });
            }

            exec(runCommand, { timeout: EXEC_TIMEOUT, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
                // Sempre deleta o arquivo temporário
                fs.unlink(tempFile, (unlinkErr) => {
                    if (unlinkErr) console.error(`⚠️ Erro ao deletar arquivo temporário ${tempFile}:`, unlinkErr);
                });

                if (error) {
                    console.error(`❌ Erro na execução (${error.code}): ${error.message}`);
                    let errorMsg = `Erro de execução:`;
                    if (error.signal === 'SIGKILL' || error.killed) {
                         errorMsg = `Erro: Tempo limite de execução excedido (${EXEC_TIMEOUT / 1000}s). O código pode conter loop infinito ou ser muito lento.`;
                    } else if (stderr) {
                         errorMsg += `\n${stderr.trim()}`;
                    } else {
                         errorMsg += `\n${error.message}`;
                    }
                     // Limita tamanho da mensagem de erro
                    if (errorMsg.length > 500) errorMsg = errorMsg.substring(0, 497) + "...";
                    socket.emit('submissionResult', { success: false, message: errorMsg });

                } else {
                    const output = stdout.trim();
                    console.log(`✅ Execução concluída. Saída: "${output}"`);
                    // Usa o output esperado específico do input ou o valor geral do nível
                    const expectedValue = requiresInitCall ? chosenOutputForLevel : currentLevel.expectedValue;
                    const expectedType = currentLevel.expectedType;

                    console.log(`🤔 Verificando - Obtido: "${output}" (Tipo: ${typeof output}), Esperado: "${expectedValue}" (Tipo JSON: ${expectedType})`);

                    if (verifyOutput(output, expectedType, expectedValue)) {
                        // --- SUCESSO ---
                        const timeTaken = Date.now() - levelStartTime;
                        const codeLength = currentCode.length;
                        // Score (exemplo simples)
                        const score = Math.max(0, Math.floor(10000 - timeTaken / 100 - codeLength));
                        const successMsg = `🏆 Nível ${currentLevel.id} (${currentLevel.context}) completo! Tempo: ${(timeTaken / 1000).toFixed(1)}s. Score: ${score}`;

                        console.log(successMsg);
                        // Envia resultado positivo para TODOS
                        io.emit('submissionResult', { success: true, message: successMsg, levelId: currentLevel.id, score, completedBy: player.nickname });

                        // Avança para o próximo nível ou finaliza
                        currentLevelIndex++;
                        if (currentLevelIndex < levels.length) {
                            console.log(`⏭️ Avançando para o próximo nível: ${currentLevelIndex + 1}`);
                            gameState = 'LEVEL_COMPLETE';
                            if(turnInterval) clearInterval(turnInterval); // Para o timer durante a pausa
                            turnInterval = null;
                            turnTimerRemaining = TURN_TIME; // Reseta para exibição
                            broadcastGameState(); // Mostra estado LEVEL_COMPLETE

                            // Pausa antes de carregar o próximo nível
                            setTimeout(() => {
                                 if (gameState === 'LEVEL_COMPLETE') { // Verifica se ainda está nesse estado (pode ter resetado)
                                     gameState = 'PLAYING'; // Muda estado ANTES de loadLevel
                                     if (loadLevel(currentLevelIndex)) { // loadLevel agora integra espectadores e retorna bool
                                          startTurn(); // Começa o novo nível com o turno 0 da nova ordem
                                          io.emit('feedback', { type: 'info', message: `Iniciando Nível ${currentLevel.id}!` });
                                          // broadcastGameState(); // startTurn já faz isso
                                     } else {
                                          // loadLevel falhou (provavelmente sem jogadores), já deve ter resetado
                                          console.log("⚠️ Carga do próximo nível falhou ou jogo finalizado.");
                                     }
                                 }
                            }, LEVEL_TRANSITION_PAUSE);

                        } else {
                            // --- FIM DO JOGO ---
                            gameOver("🎉 Parabéns! Todos os níveis foram completados!");
                        }
                    } else {
                        // --- FALHA ---
                         const failureMsg = `❌ Saída incorreta para o Nível ${currentLevel.id}.\nEsperado (${expectedType}): "${expectedValue}"\nObtido: "${output}"`;
                         console.log(failureMsg);
                         // Envia resultado negativo APENAS para quem submeteu
                         socket.emit('submissionResult', { success: false, message: failureMsg });
                    }
                } // Fim do else (sem erro de execução)
            }); // Fim do exec callback
        }); // Fim do fs.writeFile callback
    }); // Fim do submitCode handler

    // Desconexão do jogador
    socket.on('disconnect', (reason) => {
        const disconnectedPlayer = players[socket.id];
        if (!disconnectedPlayer) return; // Já foi tratado?

        const wasHost = (socket.id === hostId);
        const nickname = disconnectedPlayer.nickname;
        const wasInPlayerOrder = playerOrder.includes(socket.id);
        const oldPlayerOrderIndex = playerOrder.indexOf(socket.id); // Pega o índice ANTES de remover

        console.log(`🔌 Jogador ${nickname} (ID: ${socket.id}) desconectado. Razão: ${reason}`);

        // Remove das listas e mapa
        delete players[socket.id];
        playerConnectionOrder = playerConnectionOrder.filter(id => id !== socket.id);
        playerOrder = playerOrder.filter(id => id !== socket.id); // Remove da ordem de turno ATIVA

        // Lógica de Migração de Host (se o host saiu)
        if (wasHost) {
            console.log("👑 Host desconectado. Tentando promover novo host...");
            hostId = null; // Marca que o host saiu ANTES de promover
            promoteNextHost(); // Tenta encontrar um novo host e atualiza todos via broadcastGameState
        }

        // Ajusta jogo se estava em andamento E o jogador estava na ordem de turno
        if ((gameState === 'PLAYING' || gameState === 'LEVEL_COMPLETE') && wasInPlayerOrder) {
            if (playerOrder.length < 1) { // Se não sobrou NINGUÉM na ordem de turno ativa
                 console.log("⚠️ Último jogador ativo saiu. Voltando ao Lobby.");
                 resetGameToLobby("Jogadores insuficientes para continuar.");
                 // Não precisa mais processar turno
            } else {
                 // Ajusta o índice do turno atual se necessário
                 // Se alguém ANTES do jogador atual na ordem saiu, decrementa o índice
                 if (oldPlayerOrderIndex < currentTurnIndex) {
                     currentTurnIndex = (currentTurnIndex - 1 + playerOrder.length) % playerOrder.length; // Ajuste com módulo seguro
                     console.log(`📉 Índice do turno ajustado para ${currentTurnIndex} devido à saída de jogador anterior.`);
                 } else {
                      // Garante que o índice permaneça válido após remoção (sem decrementar se quem saiu foi o atual ou depois)
                      currentTurnIndex = currentTurnIndex % playerOrder.length;
                 }

                 // Se quem saiu era o jogador da vez E o jogo está PLAYING, passa o turno
                 // Verifica o índice ANTES da remoção para saber se era a vez dele
                 if (gameState === 'PLAYING' && oldPlayerOrderIndex === currentTurnIndex % (playerOrder.length + 1)) { // Modulo +1 por causa da remoção
                     console.log("🌪️ Jogador da vez saiu. Passando turno imediatamente.");
                     // Limpa timer antigo antes de iniciar o novo
                     if (turnInterval) clearInterval(turnInterval);
                     turnInterval = null;
                     startTurn(); // Inicia o turno do "novo" jogador atual (índice já ajustado)
                 } else if (gameState === 'PLAYING') {
                      // Se não era a vez dele, mas o jogo está rodando, apenas garante que o estado seja atualizado
                      // E que o timer continue (ou reinicie se necessário?)
                      // Apenas broadcast pode ser suficiente se o timer ainda estiver rodando para o jogador correto
                       broadcastGameState();
                 } else {
                      // Se estava em LEVEL_COMPLETE, apenas atualiza o estado
                       broadcastGameState();
                 }
            }
        } else {
            // Se estava no Lobby, GAME_OVER ou era espectador, apenas atualiza o estado
            // A promoção de host já foi tratada se aplicável
            broadcastGameState();
             // Se estava no LOBBY, verifica se o jogo pode iniciar (caso alguém desmarque 'pronto')
             // Mas não inicia automaticamente na desconexão
            if (gameState === 'LOBBY') {
                 console.log(`🚪 ${nickname} saiu do lobby.`);
                 // Poderia verificar se o número mínimo ainda é atendido, etc.
            }
        }
        // Informa a todos que o jogador saiu (após a lógica de estado ser processada)
        io.emit('feedback', { type: 'info', message: `${nickname} saiu da partida.` });

    }); // Fim do disconnect handler

}); // Fim do io.on('connection')

// --- Inicialização do Servidor ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor GitGame Multiplayer (v Host) iniciado na porta ${PORT}`);
    console.log(`🔗 Acesse em: http://localhost:${PORT}`);
    console.log(`🔧 Estado inicial: ${gameState}. Nº Mínimo Jogadores: ${MIN_PLAYERS_TO_START}. Tempo Turno: ${TURN_TIME}s.`);
});

// --- Tratamento de Encerramento (opcional mas bom) ---
process.on('SIGINT', () => {
    console.log('\n🔌 Encerrando servidor...');
    io.close(() => {
        console.log('✅ Conexões Socket.IO fechadas.');
        server.close(() => {
            console.log('✅ Servidor HTTP fechado.');
            process.exit(0);
        });
    });
     // Força o encerramento se demorar muito
     setTimeout(() => {
         console.error('⚠️ Encerramento forçado após timeout.');
         process.exit(1);
     }, 5000);
});