const express = require('express');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const http = require('http');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Carrega os níveis do arquivo JSON
let levels;
try {
  levels = JSON.parse(fs.readFileSync('levels.json', 'utf8')).levels;
} catch (err) {
  console.error("Erro ao carregar levels.json:", err);
  process.exit(1);
}

// Estado global do jogo
let currentLevelIndex = 0;
let currentLevel = levels[currentLevelIndex];
let currentCode = ""; // Código colaborativo
let levelStartTime = Date.now();

// Se o nível usa inputs para a função init, escolhe aleatoriamente um par
if (currentLevel.inputs) {
  const idx = Math.floor(Math.random() * currentLevel.inputs.length);
  currentLevel.chosenInput = currentLevel.inputs[idx];
  currentLevel.chosenExpectedOutput = currentLevel.expectedOutputs[idx];
}

// Lógica de turnos
let players = [];           // Lista de IDs (socket.id) dos jogadores conectados
let currentTurnIndex = 0;   // Índice do jogador que tem a vez
const turnTime = 30;        // Cada turno dura 30 segundos (pode ser alterado)
let turnTimer = null;

function startTurn() {
  if (players.length > 0) {
    currentTurnIndex = currentTurnIndex % players.length;
    const currentTurnID = players[currentTurnIndex];
    io.emit('turnUpdate', currentTurnID);
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(() => { nextTurn(); }, turnTime * 1000);
  }
}

function nextTurn() {
  currentTurnIndex = (currentTurnIndex + 1) % players.length;
  startTurn();
}

// Cronômetro global do nível
setInterval(() => {
  const elapsed = Date.now() - levelStartTime;
  io.emit('timerUpdate', elapsed);
}, 1000);

// Função de verificação do output
function verifyOutput(output, expectedType, expectedValue) {
  if (expectedType === "number") {
    const num = Number(output);
    if (isNaN(num)) return false;
    return num === expectedValue;
  } else if (expectedType === "boolean") {
    const boolVal = output.trim().toLowerCase();
    return (expectedValue === true && boolVal === "true") ||
           (expectedValue === false && boolVal === "false");
  } else if (expectedType === "string") {
    return output === expectedValue;
  } else {
    return output === expectedValue;
  }
}

// Socket.io: colaboração, turnos e ações do jogo
io.on('connection', socket => {
  console.log("Cliente conectado:", socket.id);
  // Envia o ID do jogador para que ele se identifique no cliente
  socket.emit('yourID', socket.id);
  
  // Adiciona o jogador à lista de turnos (se não estiver)
  if (!players.includes(socket.id)) {
    players.push(socket.id);
    if (players.length === 1) startTurn();
  }
  
  // Envia o estado completo para o novo cliente
  socket.emit('stateUpdate', {
    currentCode,
    currentLevel,
    elapsedTime: Date.now() - levelStartTime
  });
  
  // Atualização colaborativa do código – apenas quem tem a vez pode editar
  socket.on('codeUpdate', newCode => {
    const currentTurnID = players[currentTurnIndex];
    if (socket.id === currentTurnID) {
      currentCode = newCode;
      socket.broadcast.emit('codeUpdate', currentCode);
    }
  });
  
  // Jogador pode passar a vez
  socket.on('passTurn', () => {
    const currentTurnID = players[currentTurnIndex];
    if (socket.id === currentTurnID) {
      nextTurn();
    }
  });
  
  // Reset: reinicia o código e o cronômetro do nível
  socket.on('resetGame', () => {
    currentCode = "";
    levelStartTime = Date.now();
    io.emit('codeUpdate', currentCode);
    io.emit('timerReset');
  });
  
  // Submissão do código para validação
  socket.on('submitCode', () => {
    let codeToRun = currentCode;
    // Se o nível usa inputs (função init), adiciona a chamada à função init com os argumentos escolhidos
    if (currentLevel.inputs) {
      const args = currentLevel.chosenInput.join(",");
      codeToRun += `\nprint(init(${args}))`;
    }
    const tempFile = `temp_${uuidv4()}.py`;
    fs.writeFileSync(tempFile, codeToRun);
    const cmd = `python3 ${tempFile}`;
    exec(cmd, { timeout: 5000 }, (error, stdout, stderr) => {
      fs.unlinkSync(tempFile);
      if (error) {
        socket.emit('submissionResult', { success: false, message: stderr || error.message });
      } else {
        const output = stdout.trim();
        const expected = currentLevel.inputs ? currentLevel.chosenExpectedOutput : currentLevel.expectedValue;
        if (verifyOutput(output, currentLevel.expectedType, expected)) {
          const timeTaken = Date.now() - levelStartTime;
          const codeLength = currentCode.length;
          const score = Math.max(0, Math.floor(10000 - timeTaken/10 - codeLength));
          io.emit('submissionResult', { 
            success: true, 
            message: `Nível ${currentLevel.id} completado em ${(timeTaken/1000).toFixed(1)}s! Score: ${score}` 
          });
          // Avança para o próximo nível (se houver)
          if (currentLevelIndex < levels.length - 1) {
            currentLevelIndex++;
            currentLevel = levels[currentLevelIndex];
            if (currentLevel.inputs) {
              const idx = Math.floor(Math.random() * currentLevel.inputs.length);
              currentLevel.chosenInput = currentLevel.inputs[idx];
              currentLevel.chosenExpectedOutput = currentLevel.expectedOutputs[idx];
            }
            currentCode = "";
            levelStartTime = Date.now();
            io.emit('stateUpdate', { currentCode, currentLevel, elapsedTime: 0 });
          } else {
            io.emit('gameComplete', "Parabéns, todos os níveis foram completados!");
          }
        } else {
          socket.emit('submissionResult', { 
            success: false, 
            message: `Saída incorreta. Esperado (${currentLevel.expectedType}): ${expected}, obtido: ${output}` 
          });
        }
      }
    });
  });
  
  socket.on('disconnect', () => {
    console.log("Cliente desconectado:", socket.id);
    players = players.filter(id => id !== socket.id);
    if (players.length === 0 && turnTimer) clearTimeout(turnTimer);
    else if (socket.id === players[currentTurnIndex]) nextTurn();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});