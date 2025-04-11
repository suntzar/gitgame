const express = require("express");
const { exec } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const http = require("http");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = require("socket.io")(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Carrega os níveis (5 níveis desafiadores)
let levels;
try {
    levels = JSON.parse(fs.readFileSync("levels.json", "utf8")).levels;
} catch (err) {
    console.error("Erro ao carregar levels.json:", err);
    process.exit(1);
}

// Objeto para gerenciar salas; cada chave é o nome da sala
let rooms = {};

/**
 * Estrutura de uma sala:
 * {
 *    roomName: string,
 *    password: string (opcional),
 *    host: { id, name },
 *    players: [ { id, name } ],
 *    options: { turnTime: number },
 *    gameState: {
 *         currentLevelIndex, currentLevel, currentCode, levelStartTime,
 *         turn: { currentTurnIndex, turnStartTime, turnInterval }
 *    }
 * }
 */

// Cria uma nova sala (somente se o nome não existir)
app.post("/createRoom", (req, res) => {
    const { roomName, password, hostName, turnTime } = req.body;
    if (!roomName || !hostName) {
        return res.status(400).json({ message: "roomName e hostName são obrigatórios." });
    }
    if (rooms[roomName]) {
        return res.status(400).json({ message: "Sala com esse nome já existe." });
    }
    // Cria o estado inicial da sala
    const gameState = {
        currentLevelIndex: 0,
        currentLevel: levels[0],
        currentCode: "",
        levelStartTime: Date.now(),
        turn: {
            currentTurnIndex: 0,
            turnStartTime: Date.now(),
            turnInterval: null
        }
    };
    rooms[roomName] = {
        roomName,
        password: password || null,
        host: { id: null, name: hostName }, // O host.id será definido na conexão
        players: [],
        options: { turnTime: Number(turnTime) || 60 },
        gameState
    };
    return res.json({ message: "Sala criada com sucesso!", roomName });
});

// Permite que um jogador entre em uma sala
app.post("/joinRoom", (req, res) => {
    const { roomName, password, playerName } = req.body;
    if (!roomName || !playerName) {
        return res.status(400).json({ message: "roomName e playerName são obrigatórios." });
    }
    const room = rooms[roomName];
    if (!room) {
        return res.status(404).json({ message: "Sala não encontrada." });
    }
    if (room.password && room.password !== password) {
        return res.status(403).json({ message: "Senha incorreta." });
    }
    return res.json({ message: "Entrou na sala com sucesso!", roomName });
});

// Socket.io: gerenciamento de conexão e salas
io.on("connection", socket => {
    console.log("Cliente conectado:", socket.id);
    let currentRoom = null; // sala que o socket pertence

    // Evento para entrar em uma sala
    socket.on("joinRoomSocket", ({ roomName, playerName }) => {
        const room = rooms[roomName];
        if (!room) {
            socket.emit("errorMessage", "Sala não encontrada.");
            return;
        }
        // Define o host, se ainda não definido
        if (!room.host.id) {
            room.host.id = socket.id;
            room.host.name = playerName;
        }
        // Adiciona o jogador se não estiver na lista
        if (!room.players.find(p => p.id === socket.id)) {
            room.players.push({ id: socket.id, name: playerName });
        }
        currentRoom = roomName;
        socket.join(roomName);
        // Envia o estado atual da sala para o novo jogador
        socket.emit("stateUpdate", room.gameState);
        // Atualiza todos na sala com a lista de jogadores e turno
        io.in(roomName).emit("playersUpdate", room.players);
        // Se o host for definido e nenhum turno estiver ativo, inicia o turno
        if (room.players.length > 0 && !room.gameState.turn.turnInterval) {
            startTurnInRoom(roomName);
        }
    });

    // Envia atualizações de código dentro da sala
    socket.on("codeUpdate", newCode => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        // Só permite se for a vez do jogador
        const currentTurnID = room.players[room.gameState.turn.currentTurnIndex].id;
        if (socket.id === currentTurnID) {
            room.gameState.currentCode = newCode;
            socket.to(currentRoom).emit("codeUpdate", newCode);
        }
    });

    // Evento para passar a vez (somente se for a vez do jogador)
    socket.on("passTurn", () => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        const currentTurnID = room.players[room.gameState.turn.currentTurnIndex].id;
        if (socket.id === currentTurnID) {
            nextTurnInRoom(currentRoom);
        }
    });

    // Evento para reset do jogo na sala (reinicia código e cronômetro global)
    socket.on("resetGame", () => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        room.gameState.currentCode = "";
        room.gameState.levelStartTime = Date.now();
        io.in(currentRoom).emit("codeUpdate", "");
        io.in(currentRoom).emit("globalTimerReset");
    });

    // Submissão do código para validação
    socket.on("submitCode", () => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        let codeToRun = room.gameState.currentCode;
        // Se o nível usa inputs, insere chamada da função test() com o input escolhido
        if (room.gameState.currentLevel.inputs) {
            if (!room.gameState.currentLevel.chosenInput) {
                const idx = Math.floor(Math.random() * room.gameState.currentLevel.inputs.length);
                room.gameState.currentLevel.chosenInput = room.gameState.currentLevel.inputs[idx];
                room.gameState.currentLevel.chosenExpectedOutput = room.gameState.currentLevel.expectedOutputs[idx];
            }
            const args = room.gameState.currentLevel.chosenInput.join(", ");
            codeToRun += `\nprint(test(${args}))`;
        }
        const tempFile = `temp_${uuidv4()}.py`;
        fs.writeFileSync(tempFile, codeToRun);
        exec(`python3 ${tempFile}`, { timeout: 5000 }, (error, stdout, stderr) => {
            fs.unlinkSync(tempFile);
            if (error) {
                socket.emit("submissionResult", { success: false, message: stderr || error.message });
            } else {
                const output = stdout.trim();
                const expected = room.gameState.currentLevel.inputs ? room.gameState.currentLevel.chosenExpectedOutput : room.gameState.currentLevel.expectedValue;
                if (verifyOutput(output, room.gameState.currentLevel.expectedType, expected)) {
                    const timeTaken = Date.now() - room.gameState.levelStartTime;
                    const codeLength = room.gameState.currentCode.length;
                    const score = Math.max(0, Math.floor(10000 - timeTaken / 10 - codeLength));
                    io.in(currentRoom).emit("submissionResult", { success: true, message: `Nível ${room.gameState.currentLevel.id} completado em ${(timeTaken / 1000).toFixed(1)}s! Score: ${score}` });
                    // Avança para o próximo nível ou finaliza o jogo
                    if (room.gameState.currentLevelIndex < levels.length - 1) {
                        room.gameState.currentLevelIndex++;
                        room.gameState.currentLevel = levels[room.gameState.currentLevelIndex];
                        if (room.gameState.currentLevel.inputs) {
                            const idx = Math.floor(Math.random() * room.gameState.currentLevel.inputs.length);
                            room.gameState.currentLevel.chosenInput = room.gameState.currentLevel.inputs[idx];
                            room.gameState.currentLevel.chosenExpectedOutput = room.gameState.currentLevel.expectedOutputs[idx];
                        }
                        room.gameState.currentCode = "";
                        room.gameState.levelStartTime = Date.now();
                        io.in(currentRoom).emit("stateUpdate", room.gameState);
                    } else {
                        io.in(currentRoom).emit("gameComplete", "Parabéns, todos os níveis foram completados!");
                    }
                } else {
                    socket.emit("submissionResult", { success: false, message: `Saída incorreta. Esperado (${room.gameState.currentLevel.expectedType}): ${expected}, obtido: ${output}` });
                }
            }
        });
    });

    // Em caso de desconexão, remove o jogador da sala e atualiza turnos
    socket.on("disconnect", () => {
        console.log("Cliente desconectado:", socket.id);
        if (currentRoom) {
            const room = rooms[currentRoom];
            room.players = room.players.filter(p => p.id !== socket.id);
            io.in(currentRoom).emit("playersUpdate", room.players);
            if (room.players.length === 0) {
                if (room.gameState.turn.turnInterval) clearInterval(room.gameState.turn.turnInterval);
                delete rooms[currentRoom];
            } else if (socket.id === room.players[room.gameState.turn.currentTurnIndex]?.id) {
                nextTurnInRoom(currentRoom);
            }
        }
    });
});

// Funções para gerenciar turnos em uma sala
function startTurnInRoom(roomName) {
    const room = rooms[roomName];
    if (!room || room.players.length === 0) return;
    room.gameState.turn.currentTurnIndex = room.gameState.turn.currentTurnIndex % room.players.length;
    const currentTurnID = room.players[room.gameState.turn.currentTurnIndex].id;
    room.gameState.turn.turnStartTime = Date.now();
    io.in(roomName).emit("turnUpdate", currentTurnID);
    if (room.gameState.turn.turnInterval) clearInterval(room.gameState.turn.turnInterval);
    room.gameState.turn.turnInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - room.gameState.turn.turnStartTime) / 1000);
        const remaining = Math.max(0, room.options.turnTime - elapsed);
        io.in(roomName).emit("turnTimerUpdate", remaining);
        if (remaining <= 0) nextTurnInRoom(roomName);
    }, 1000);
}

function nextTurnInRoom(roomName) {
    const room = rooms[roomName];
    if (!room || room.players.length === 0) return;
    room.gameState.turn.currentTurnIndex = (room.gameState.turn.currentTurnIndex + 1) % room.players.length;
    startTurnInRoom(roomName);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
