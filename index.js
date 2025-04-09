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

// Carrega os níveis a partir do arquivo JSON
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
let currentCode = ""; // Código colaborativo compartilhado
let levelStartTime = Date.now();

// Se o nível usa inputs para a função init, escolherá (apenas uma vez) um par de input e o output correspondente  
// (esses campos devem existir no nível, por exemplo: "inputs": [[1,1],[2,1],...], "expectedOutputs": [2,3,...])
if (currentLevel.inputs) {
  const idx = Math.floor(Math.random() * currentLevel.inputs.length);
  currentLevel.chosenInput = currentLevel.inputs[idx];
  currentLevel.chosenExpectedOutput = currentLevel.expectedOutputs[idx];
}

// --- Lógica de Turno (para edição) ---
let players = [];            // Array de socket.id dos jogadores conectados
let currentTurnIndex = 0;    // Índice do jogador cujo turno está ativo
const turnTime = 30000;      // 30 segundos por turno (pode ser alterado)
let turnTimer = null;

function startTurn() {
  if (players.length > 0) {
    currentTurnIndex = currentTurnIndex % players.length;
    const currentTurnId = players[currentTurnIndex];
    io.emit('turnUpdate', currentTurnId);
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(() => {
      nextTurn();
    }, turnTime);
  }
}

function nextTurn() {
  currentTurnIndex = (currentTurnIndex + 1) % players.length;
  startTurn();
}

// --- Cronômetro global (para o nível) ---
setInterval(() => {
  const elapsed = Date.now() - levelStartTime;
  io.emit('timerUpdate', elapsed);
}, 1000);

// Função para comparar o output produzido com o esperado
function verifyOutput(output, expectedType, expectedValue) {
  if (expectedType === "number") {
    const num = Number(output);
    if (isNaN(num)) return false;
    return num === expectedValue;
  } else if (expectedType === "boolean") {
    const boolVal = output.trim().toLowerCase();
    if (expectedValue === true) {
      return boolVal === "true";
    } else {
      return boolVal === "false";
    }
  } else if (expectedType === "string") {
    return output === expectedValue;
  } else {
    return output === expectedValue;
  }
}

// Socket.io: gerenciamento da colaboração, turnos e ações do jogo
io.on('connection', socket => {
  console.log("Cliente conectado:", socket.id);
  
  // Envie ao cliente seu ID para identificação local
  socket.emit('yourID', socket.id);
  
  // Adiciona o jogador à lista de turnos (se ainda não estiver)
  if (!players.includes(socket.id)) {
    players.push(socket.id);
    // Se for o primeiro jogador, inicia o turno
    if (players.length === 1) startTurn();
  }
  
  // Envia o estado completo (código, nível, tempo) para o novo cliente
  socket.emit('stateUpdate', {
    currentCode,
    currentLevel,
    elapsedTime: Date.now() - levelStartTime
  });
  
  // Atualização colaborativa: quando um jogador edita, o novo código é distribuído
  socket.on('codeUpdate', newCode => {
    // Apenas o jogador que estiver com a vez pode enviar alterações
    const currentTurnId = players[currentTurnIndex];
    if (socket.id === currentTurnId) {
      currentCode = newCode;
      socket.broadcast.emit('codeUpdate', currentCode);
    }
  });
  
  // Evento para passar a vez (o jogador pode clicar no botão para passar)
  socket.on('passTurn', () => {
    const currentTurnId = players[currentTurnIndex];
    if (socket.id === currentTurnId) {
      nextTurn();
    }
  });
  
  // Reset: reinicia o código e o cronômetro do nível atual
  socket.on('resetGame', () => {
    currentCode = "";
    levelStartTime = Date.now();
    io.emit('codeUpdate', currentCode);
    io.emit('timerReset');
  });
  
  // Submissão do código: o servidor executa o código e verifica o resultado
  socket.on('submitCode', () => {
    let codeToRun = currentCode;
    // Se o nível usa inputs (função init), o servidor deve chamar init com o input escolhido
    if (currentLevel.inputs) {
      // Se ainda não foi escolhido, escolha um par aleatório
      if (!currentLevel.chosenInput) {
        const idx = Math.floor(Math.random() * currentLevel.inputs.length);
        currentLevel.chosenInput = currentLevel.inputs[idx];
        currentLevel.chosenExpectedOutput = currentLevel.expectedOutputs[idx];
      }
      const args = currentLevel.chosenInput.join(",");
      // Adiciona ao código uma chamada à função init com os argumentos e imprime o resultado
      codeToRun += `\nprint(init(${args}))`;
    }
    
    // Cria um arquivo temporário com o código a ser executado
    const tempFile = `temp_${uuidv4()}.py`;
    fs.writeFileSync(tempFile, codeToRun);
    const cmd = `python3 ${tempFile}`;
    exec(cmd, { timeout: 5000 }, (error, stdout, stderr) => {
      fs.unlinkSync(tempFile);
      if (error) {
        socket.emit('submissionResult', { success: false, message: stderr || error.message });
      } else {
        const output = stdout.trim();
        // Para níveis com inputs, use o chosenExpectedOutput; caso contrário, use expectedValue
        const expected = currentLevel.inputs ? currentLevel.chosenExpectedOutput : currentLevel.expectedValue;
        if (verifyOutput(output, currentLevel.expectedType, expected)) {
          const timeTaken = Date.now() - levelStartTime;
          const codeLength = currentCode.length;
          // Exemplo simples de score: quanto menor o tempo e o código, maior o score
          const score = Math.max(0, Math.floor(10000 - timeTaken/10 - codeLength));
          io.emit('submissionResult', { 
            success: true, 
            message: `Nível ${currentLevel.id} completado em ${(timeTaken/1000).toFixed(1)} segundos! Score: ${score}` 
          });
          // Avança para o próximo nível, se houver
          if (currentLevelIndex < levels.length - 1) {
            currentLevelIndex++;
            currentLevel = levels[currentLevelIndex];
            // Se o novo nível usa inputs, reseta os campos de input
            if (currentLevel.inputs) {
              const idx = Math.floor(Math.random() * currentLevel.inputs.length);
              currentLevel.chosenInput = currentLevel.inputs[idx];
              currentLevel.chosenExpectedOutput = currentLevel.expectedOutputs[idx];
            }
            currentCode = "";
            levelStartTime = Date.now();
            io.emit('stateUpdate', {
              currentCode,
              currentLevel,
              elapsedTime: 0
            });
          } else {
            io.emit('gameComplete', "Parabéns, todos os níveis foram completados!");
          }
        } else {
          socket.emit('submissionResult', { 
            success: false, 
            message: `Saída incorreta. Esperado (${currentLevel.expectedType}): ${currentLevel.inputs ? currentLevel.chosenExpectedOutput : currentLevel.expectedValue}, obtido: ${output}` 
          });
        }
      }
    });
  });
  
  socket.on('disconnect', () => {
    console.log("Cliente desconectado:", socket.id);
    // Remove o jogador da lista de turnos
    players = players.filter(id => id !== socket.id);
    if (players.length === 0) {
      if (turnTimer) clearTimeout(turnTimer);
    } else {
      // Se o jogador desconectado era o da vez, passa a vez
      if (socket.id === players[currentTurnIndex]) {
        nextTurn();
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});