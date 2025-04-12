const express = require('express');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { Z_ASCII } = require('zlib'); // Import Z_ASCII from zlib

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Configurações ---
const MIN_PLAYERS_TO_START = 2;
const TURN_TIME = 60; // segundos por turno

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
let players = {}; // Mapa de jogadores: { socketId: { id, nickname, isReady } }
let playerOrder = []; // Array de IDs na ordem do turno (definido quando o jogo começa)
let currentLevelIndex = 0;
let currentLevel = null; // Será definido ao iniciar o jogo
let currentCode = "";
let levelStartTime = null;
let chosenInputForLevel = null; // Input escolhido para o nível atual
let chosenOutputForLevel = null; // Output esperado para o input escolhido

// --- Lógica de Turnos e Cronômetros ---
let currentTurnIndex = 0;
let turnStartTime = null;
let turnInterval = null;
let turnTimerRemaining = TURN_TIME;

// Função para enviar estado completo (ou relevante) a todos os jogadores
function broadcastGameState() {
    const state = {
        gameState,
        players: Object.values(players), // Envia lista de jogadores com nickname/ready status
        playerOrder, // Envia a ordem dos turnos se o jogo estiver rodando
        currentTurnIndex,
        currentLevel: gameState !== 'LOBBY' ? currentLevel : null,
        currentCode: gameState !== 'LOBBY' ? currentCode : "",
        chosenInput: gameState !== 'LOBBY' ? chosenInputForLevel : null,
        chosenExpectedOutput: gameState !== 'LOBBY' ? chosenOutputForLevel : null,
        turnTimerRemaining: turnTimerRemaining,
        levelStartTime // Para cálculo de tempo total se necessário no cliente
    };
    io.emit('gameStateUpdate', state);
    // Log detalhado do estado enviado
    // console.log("📢 Estado enviado:", JSON.stringify(state, null, 2));
}

// Função que envia o tempo restante do turno a cada segundo
function broadcastTurnTimer() {
    const elapsed = Math.floor((Date.now() - turnStartTime) / 1000);
    turnTimerRemaining = Math.max(0, TURN_TIME - elapsed);
    // Envia apenas o tempo restante para otimizar
    io.emit('turnTimerUpdate', turnTimerRemaining);

    if (turnTimerRemaining <= 0) {
        console.log(`⏳ Tempo esgotado para ${players[playerOrder[currentTurnIndex]]?.nickname}. Próximo turno.`);
        nextTurn();
    }
}

// Inicia o turno do jogador atual
function startTurn() {
    if (playerOrder.length === 0 || gameState !== 'PLAYING') {
        if (turnInterval) clearInterval(turnInterval);
        turnInterval = null;
        console.log("⚠️ Tentativa de iniciar turno sem jogadores ou fora do estado PLAYING.");
        return;
    }

    // Garante que o índice seja válido após remoções
    currentTurnIndex = currentTurnIndex % playerOrder.length;
    const currentTurnID = playerOrder[currentTurnIndex];
    const currentPlayer = players[currentTurnID];

    if (!currentPlayer) {
        console.error(`❌ Jogador ${currentTurnID} não encontrado no mapa 'players' ao iniciar turno. Tentando próximo.`);
        // Tenta avançar para o próximo, pode acontecer em race condition de desconexão
        nextTurn();
        return;
    }

    turnStartTime = Date.now();
    turnTimerRemaining = TURN_TIME; // Reseta o tempo para o novo turno
    console.log(`▶️ Iniciando turno para ${currentPlayer.nickname} (ID: ${currentTurnID}) - Índice ${currentTurnIndex}`);

    // Limpa intervalo antigo e inicia novo
    if (turnInterval) clearInterval(turnInterval);
    turnInterval = setInterval(broadcastTurnTimer, 1000);

    // Envia atualização de quem é a vez (além do gameStateUpdate geral)
    io.emit('turnUpdate', { currentTurnID, nickname: currentPlayer.nickname });
    broadcastGameState(); // Garante que todos tenham o estado mais recente
}

// Passa a vez para o próximo jogador
function nextTurn() {
    if (playerOrder.length === 0 || gameState !== 'PLAYING') {
        console.log("⚠️ Tentativa de passar o turno sem jogadores ou fora do estado PLAYING.");
        if (turnInterval) clearInterval(turnInterval);
        turnInterval = null;
        // Se não há jogadores, volta pro Lobby
        if (playerOrder.length === 0 && gameState === 'PLAYING') {
             resetGameToLobby("Nenhum jogador restante.");
        }
        return;
    }
    currentTurnIndex = (currentTurnIndex + 1) % playerOrder.length;
    console.log(`⏩ Próximo turno. Novo índice: ${currentTurnIndex}`);
    startTurn(); // Inicia o turno do próximo jogador
}

// Cronômetro global do nível (se necessário no futuro)
// let globalTimerInterval = null;
// function startGlobalTimer() {
//     levelStartTime = Date.now();
//     if (globalTimerInterval) clearInterval(globalTimerInterval);
//     globalTimerInterval = setInterval(() => {
//         const elapsed = Date.now() - levelStartTime;
//         io.emit('globalTimerUpdate', elapsed);
//     }, 1000);
// }

// Função para iniciar o jogo
function startGame() {
    if (gameState !== 'LOBBY') return; // Só pode iniciar do Lobby

    const readyPlayers = Object.values(players).filter(p => p.isReady);
    if (readyPlayers.length < MIN_PLAYERS_TO_START) {
        console.log(`🏁 Tentativa de iniciar jogo sem jogadores suficientes (${readyPlayers.length}/${MIN_PLAYERS_TO_START}) ou nem todos prontos.`);
        return; // Não inicia
    }

    console.log("🚀 Iniciando Jogo!");
    gameState = 'PLAYING';
    playerOrder = readyPlayers.map(p => p.id); // Define a ordem do turno
    // Poderia embaralhar: playerOrder.sort(() => Math.random() - 0.5);
    currentLevelIndex = 0;
    currentTurnIndex = 0; // Começa com o primeiro jogador na ordem definida
    currentCode = "";
    levelStartTime = Date.now();
    // startGlobalTimer(); // Inicia cronômetro global se for usar

    loadLevel(currentLevelIndex);
    startTurn(); // Inicia o primeiro turno
    broadcastGameState(); // Envia o estado inicial do jogo
}

// Carrega um nível específico
function loadLevel(index) {
    if (index >= levels.length) {
        gameOver("Todos os níveis foram completados!");
        return;
    }
    currentLevel = levels[index];
    currentCode = currentLevel.initialCode || ""; // Usa um código inicial se definido no JSON
    chosenInputForLevel = null;
    chosenOutputForLevel = null;

    // Se o nível usa inputs, escolhe um par aleatório AGORA
    if (currentLevel.inputs && currentLevel.inputs.length > 0) {
        const idx = Math.floor(Math.random() * currentLevel.inputs.length);
        chosenInputForLevel = currentLevel.inputs[idx];
        chosenOutputForLevel = currentLevel.expectedOutputs[idx];
        console.log(`🧩 Nível ${currentLevel.id} carregado. Input escolhido: ${chosenInputForLevel}, Output esperado: ${chosenOutputForLevel}`);
    } else {
        console.log(`🧩 Nível ${currentLevel.id} carregado. Output esperado: ${currentLevel.expectedValue}`);
    }
    levelStartTime = Date.now(); // Reinicia cronômetro do nível
}

// Finaliza o jogo
function gameOver(message) {
    console.log("🎉 Jogo Finalizado:", message);
    gameState = 'GAME_OVER';
    if (turnInterval) clearInterval(turnInterval);
    // if (globalTimerInterval) clearInterval(globalTimerInterval);
    turnInterval = null;
    // globalTimerInterval = null;
    playerOrder = []; // Limpa ordem
    Object.values(players).forEach(p => p.isReady = false); // Marca todos como não prontos
    io.emit('gameComplete', message); // Evento específico para o fim
    broadcastGameState(); // Atualiza o estado geral
}

// Reseta o jogo para o estado de Lobby
function resetGameToLobby(reason = "Jogo resetado.") {
     console.log(`🔄 Resetando jogo para LOBBY. Razão: ${reason}`);
     gameState = 'LOBBY';
     if (turnInterval) clearInterval(turnInterval);
     // if (globalTimerInterval) clearInterval(globalTimerInterval);
     turnInterval = null;
    //  globalTimerInterval = null;
     playerOrder = [];
     currentLevelIndex = 0;
     currentLevel = null;
     currentCode = "";
     levelStartTime = null;
     Object.values(players).forEach(p => p.isReady = false); // Marca todos como não prontos
     broadcastGameState();
}

// Função de verificação rigorosa do output (sem mudanças)
function verifyOutput(output, expectedType, expectedValue) {
    output = String(output).trim(); // Garante que é string e remove espaços extras
    expectedValue = String(expectedValue).trim(); // Garante comparação de strings

    if (expectedType === "number") {
        // Compara como números, permitindo pequenas diferenças de float se necessário
        const numOut = Number(output);
        const numExp = Number(expectedValue);
        if (isNaN(numOut) || isNaN(numExp)) return false;
        // return Math.abs(numOut - numExp) < 0.0001; // Para floats
        return numOut === numExp; // Para inteiros
    } else if (expectedType === "boolean") {
        const boolOut = output.toLowerCase();
        const boolExp = expectedValue.toLowerCase();
        return (boolExp === "true" && boolOut === "true") ||
               (boolExp === "false" && boolOut === "false");
    }
     // Para string e outros tipos, comparação direta
     return output === expectedValue;
}


// --- Socket.io Event Handlers ---
io.on('connection', socket => {
    const playerIP = socket.handshake.address; // Pega o IP para log
    console.log(`🔌 Novo cliente conectado: ${socket.id} (IP: ${playerIP})`);

    // Cria o objeto do jogador
    const playerNickname = `Jogador_${socket.id.substring(0, 4)}`;
    players[socket.id] = {
        id: socket.id,
        nickname: playerNickname,
        isReady: false,
    };
    console.log(`👤 Jogador ${playerNickname} (ID: ${socket.id}) entrou.`);

    // Envia o ID e estado atual para o novo jogador
    socket.emit('yourInfo', { id: socket.id, nickname: playerNickname });
    socket.emit('gameStateUpdate', { // Envia estado atual para o novo jogador
        gameState,
        players: Object.values(players),
        playerOrder,
        currentTurnIndex,
        currentLevel: gameState !== 'LOBBY' ? currentLevel : null,
        currentCode: gameState !== 'LOBBY' ? currentCode : "",
        chosenInput: gameState !== 'LOBBY' ? chosenInputForLevel : null,
        chosenExpectedOutput: gameState !== 'LOBBY' ? chosenOutputForLevel : null,
        turnTimerRemaining,
        levelStartTime
    });

    // Notifica todos sobre o novo jogador (atualiza a lista de jogadores)
    broadcastGameState();

    // ---- Eventos do Cliente ----

    // Jogador define/muda o apelido
    socket.on('setNickname', (newNickname) => {
        const sanitizedNickname = String(newNickname || "").trim().substring(0, 20); // Limpa e limita
        if (sanitizedNickname && players[socket.id]) {
            const oldNickname = players[socket.id].nickname;
            players[socket.id].nickname = sanitizedNickname;
            console.log(`🏷️ Apelido alterado: ${oldNickname} -> ${sanitizedNickname} (ID: ${socket.id})`);
            broadcastGameState(); // Atualiza a lista para todos
        }
    });

    // Jogador marca/desmarca "Pronto" (só no Lobby)
    socket.on('toggleReady', () => {
        if (gameState === 'LOBBY' && players[socket.id]) {
            players[socket.id].isReady = !players[socket.id].isReady;
            console.log(`✅ Jogador ${players[socket.id].nickname} ${players[socket.id].isReady ? 'está pronto' : 'não está pronto'}.`);
            broadcastGameState();

            // Verifica se todos estão prontos para iniciar automaticamente
            const allPlayers = Object.values(players);
            if (allPlayers.length >= MIN_PLAYERS_TO_START && allPlayers.every(p => p.isReady)) {
                startGame();
            }
        }
    });

    // Atualização colaborativa do código (só o jogador da vez pode)
    socket.on('codeUpdate', (newCode) => {
        if (gameState === 'PLAYING' && playerOrder.length > 0 && socket.id === playerOrder[currentTurnIndex]) {
            // Verifica se o código realmente mudou para evitar envios desnecessários
            if (currentCode !== newCode) {
                 currentCode = newCode;
                 // Transmite a mudança para os outros jogadores
                 socket.broadcast.emit('codeUpdate', currentCode);
            }
        } else if (gameState !== 'PLAYING') {
             console.warn(`⚠️ ${players[socket.id]?.nickname} tentou editar código fora do estado PLAYING.`);
        } else if (playerOrder.length === 0) {
             console.warn(`⚠️ ${players[socket.id]?.nickname} tentou editar código sem jogadores na ordem.`);
        } else if (socket.id !== playerOrder[currentTurnIndex]) {
            console.warn(`⚠️ ${players[socket.id]?.nickname} tentou editar código fora da sua vez.`);
            // Opcional: Enviar um aviso para o cliente que tentou editar fora da vez
             socket.emit('actionError', 'Não é sua vez de editar!');
        }
    });

    // Jogador da vez passa o turno manualmente
    socket.on('passTurn', () => {
        if (gameState === 'PLAYING' && playerOrder.length > 0 && socket.id === playerOrder[currentTurnIndex]) {
            console.log(`🙋 ${players[socket.id].nickname} passou a vez.`);
            nextTurn();
        } else {
            console.warn(`⚠️ ${players[socket.id]?.nickname} tentou passar a vez fora das condições.`);
            socket.emit('actionError', 'Você não pode passar a vez agora.');
        }
    });

    // Reset do NÍVEL ATUAL (só durante o jogo)
    socket.on('resetLevel', () => {
        if (gameState === 'PLAYING') {
            console.log(`🔄 Nível ${currentLevel?.id} resetado por ${players[socket.id]?.nickname}.`);
            // Reinicia o código para o inicial do nível ou vazio
            currentCode = currentLevel.initialCode || "";
            levelStartTime = Date.now(); // Reinicia cronômetro do nível
             // Não reinicia o turno, continua de onde parou
            // Poderia optar por reiniciar o cronômetro do turno atual também:
            // turnStartTime = Date.now();
            broadcastGameState(); // Envia estado atualizado (código resetado)
            io.emit('codeUpdate', currentCode); // Força atualização do código para todos
             // Enviar feedback
             io.emit('feedback', { type: 'info', message: `Nível resetado por ${players[socket.id]?.nickname}.` });
        } else {
            socket.emit('actionError', 'Só é possível resetar o nível durante o jogo.');
        }
    });

     // Botão para voltar ao Lobby (se o jogo acabou ou travou)
     socket.on('forceResetToLobby', () => {
          console.log(`🚪 ${players[socket.id]?.nickname} forçou o retorno ao Lobby.`);
          resetGameToLobby(`Retorno forçado por ${players[socket.id]?.nickname}`);
          io.emit('feedback', { type: 'warning', message: `Jogo resetado para o Lobby por ${players[socket.id]?.nickname}.` });
     });

    // Submissão do código (qualquer jogador pode submeter durante PLAYING)
    socket.on('submitCode', () => {
        if (gameState !== 'PLAYING') {
            socket.emit('submissionResult', { success: false, message: "O jogo não está em andamento." });
            return;
        }
        if (!currentLevel) {
             socket.emit('submissionResult', { success: false, message: "Erro: Nível atual não definido." });
             return;
        }

        console.log(` Gato` );


        let codeToRun = currentCode;
        const tempFile = `temp_${uuidv4()}.py`;
        let runCommand = `python3 ${tempFile}`;

        // Adiciona a chamada da função init com os inputs escolhidos, se aplicável
        if (currentLevel.inputs) {
             if (!chosenInputForLevel) {
                 console.error("❌ Erro crítico: Nível requer input, mas nenhum foi escolhido.");
                 socket.emit('submissionResult', { success: false, message: "Erro interno do servidor: Input não definido." });
                 return;
             }
             // Formata os argumentos corretamente (strings precisam de aspas)
             const args = chosenInputForLevel.map(arg =>
                 typeof arg === 'string' ? `"${arg.replace(/"/g, '\\"')}"` : arg
             ).join(", ");
             codeToRun += `\n\n# --- Server Appended --- \nprint(init(${args}))`; // Adiciona chamada
             console.log(`🐍 Executando com input: init(${args})`);
        } else if (!currentLevel.expectedValue) {
            // Se não tem input e nem expectedValue direto, talvez espere que print algo?
             // Adapte conforme a necessidade dos níveis sem input. Se main() deve printar:
             codeToRun += `\n\n# --- Server Appended --- \nif __name__ == "__main__":\n    main()`;
             console.log(`🐍 Executando main() esperado.`);
        } else {
             // Nível simples sem input, mas com valor esperado (ex: Nível 1)
             // Assumimos que o código do usuário deve imprimir o valor diretamente, ou uma função `main()` o faz.
             // Para o Nível 1, o usuário deve escrever `print('Hello World!')`.
             // Se a regra for sempre chamar `main()`, descomente a linha abaixo:
             // codeToRun += `\n\n# --- Server Appended --- \nif __name__ == "__main__":\n    main()`;
             console.log(`🐍 Executando código diretamente.`);
        }


        console.log(`💾 Código a ser executado em ${tempFile}:\n---\n${codeToRun}\n---`);

        fs.writeFileSync(tempFile, codeToRun);

        exec(runCommand, { timeout: 5000 }, (error, stdout, stderr) => {
            fs.unlinkSync(tempFile); // Deleta o arquivo temporário

            if (error) {
                console.error(`❌ Erro na execução: ${error.message}`);
                // Verifica se foi timeout
                if (error.signal === 'SIGTERM') {
                     socket.emit('submissionResult', { success: false, message: `Erro: Tempo limite de execução excedido (5s).` });
                } else {
                     socket.emit('submissionResult', { success: false, message: `Erro de execução:\n${stderr || error.message}` });
                }
            } else {
                const output = stdout.trim();
                 console.log(`✅ Execução concluída. Saída: "${output}"`);
                const expectedValue = currentLevel.inputs ? chosenOutputForLevel : currentLevel.expectedValue;
                const expectedType = currentLevel.expectedType;

                console.log(`🤔 Verificando - Obtido: "${output}" (Tipo: ${typeof output}), Esperado: "${expectedValue}" (Tipo JSON: ${expectedType})`);


                if (verifyOutput(output, expectedType, expectedValue)) {
                    const timeTaken = Date.now() - levelStartTime;
                    const codeLength = currentCode.length;
                    // Score simples (ajuste conforme necessário)
                    const score = Math.max(0, Math.floor(10000 - timeTaken / 100 - codeLength * 2));

                    const successMsg = `🏆 Nível ${currentLevel.id} (${currentLevel.context}) completo! Tempo: ${(timeTaken / 1000).toFixed(1)}s. Score: ${score}`;
                    console.log(successMsg);
                    io.emit('submissionResult', { success: true, message: successMsg, levelId: currentLevel.id, score }); // Envia para todos

                    // Avança para o próximo nível
                    currentLevelIndex++;
                    if (currentLevelIndex < levels.length) {
                        console.log(`⏭️ Avançando para o próximo nível: ${currentLevelIndex}`);
                        gameState = 'LEVEL_COMPLETE'; // Estado intermediário
                        broadcastGameState();
                        setTimeout(() => {
                             loadLevel(currentLevelIndex);
                             gameState = 'PLAYING';
                             // Reinicia o turno ou continua? Vamos reiniciar do jogador 0.
                             currentTurnIndex = 0;
                             startTurn(); // Começa o novo nível com o turno 0
                             io.emit('feedback', { type: 'info', message: `Iniciando Nível ${currentLevel.id}!` });
                        }, 3000); // Pausa de 3 segundos antes do próximo nível

                    } else {
                        gameOver("🎉 Parabéns! Todos os níveis foram completados!");
                    }
                } else {
                     const failureMsg = `❌ Saída incorreta para o Nível ${currentLevel.id}. Esperado (${expectedType}): ${expectedValue}, Obtido: ${output}`;
                     console.log(failureMsg);
                     socket.emit('submissionResult', { success: false, message: failureMsg }); // Envia só para quem submeteu
                }
            }
        });
    });

    // Desconexão do jogador
    socket.on('disconnect', (reason) => {
        const disconnectedPlayer = players[socket.id];
        if (!disconnectedPlayer) return; // Já foi removido?

        console.log(`🔌 Jogador ${disconnectedPlayer.nickname} (ID: ${socket.id}) desconectado. Razão: ${reason}`);
        const wasTurnHolder = gameState === 'PLAYING' && playerOrder.length > 0 && playerOrder[currentTurnIndex] === socket.id;
        const oldPlayerOrderIndex = playerOrder.indexOf(socket.id); // Posição na ordem do turno

        delete players[socket.id]; // Remove do mapa geral

        // Ajusta a ordem do turno APENAS se o jogo estiver rodando
        if (gameState === 'PLAYING') {
            playerOrder = playerOrder.filter(id => id !== socket.id); // Remove da ordem do turno

            if (playerOrder.length < 1) { // Se não sobrar ninguém (ou se o mínimo for > 1 e não atender)
                 console.log("⚠️ Último jogador saiu durante o jogo. Voltando ao Lobby.");
                 resetGameToLobby("Jogadores insuficientes para continuar.");
            } else {
                // Ajusta o índice do turno atual se necessário
                if (oldPlayerOrderIndex !== -1 && oldPlayerOrderIndex < currentTurnIndex) {
                    // Se alguém ANTES do jogador atual saiu, decrementa o índice para manter o próximo jogador correto
                    currentTurnIndex--;
                     console.log(`📉 Índice do turno ajustado para ${currentTurnIndex} devido à saída de jogador anterior.`);
                }
                 // Garante que o índice permaneça válido após remoção/ajuste
                 currentTurnIndex = currentTurnIndex % playerOrder.length;

                 // Se quem saiu era o jogador da vez, passa o turno imediatamente para o próximo
                 if (wasTurnHolder) {
                     console.log("🌪️ Jogador da vez saiu. Passando turno imediatamente.");
                     // Não precisa incrementar o índice aqui, pois o 'startTurn' já pegará o 'currentTurnIndex' correto (que pode ter sido ajustado ou não)
                     startTurn(); // Inicia o turno do "novo" jogador atual
                 } else {
                     // Se não era o jogador da vez, apenas atualiza o estado geral
                     broadcastGameState();
                 }
            }
        } else {
             // Se estava no Lobby ou outro estado, apenas atualiza a lista
             broadcastGameState();
              // Se estava no LOBBY, verifica se ainda pode iniciar (caso alguém desmarque 'pronto')
              if (gameState === 'LOBBY') {
                   const allPlayers = Object.values(players);
                   if (allPlayers.length >= MIN_PLAYERS_TO_START && allPlayers.every(p => p.isReady)) {
                        // Teoricamente não deveria acontecer se alguém saiu, mas por segurança
                        // startGame();
                   } else if (allPlayers.some(p => !p.isReady)) {
                        // Garante que se alguém sair e o jogo estava "quase pronto", ele não inicie erroneamente
                        console.log("🧘‍♂️ Jogador saiu do lobby, aguardando prontidão novamente.");
                   }
              }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor GitGame Multiplayer iniciado na porta ${PORT}`);
    console.log(`🔗 Acesse em: http://localhost:${PORT}`);
});