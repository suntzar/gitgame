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
let currentCode = ""; // código colaborativo compartilhado
let levelStartTime = Date.now();

// Envia a cada segundo o tempo decorrido para os clientes
setInterval(() => {
  const elapsed = Date.now() - levelStartTime;
  io.emit('timerUpdate', elapsed);
}, 1000);

// Função para verificar a saída produzida versus o esperado (tipo e valor)
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

// Socket.io: gerencia a colaboração e as ações do jogo
io.on('connection', socket => {
  console.log("Cliente conectado:", socket.id);
  
  // Envia o estado atual para o novo cliente
  socket.emit('stateUpdate', {
    currentCode,
    currentLevel,
    elapsedTime: Date.now() - levelStartTime
  });
  
  // Atualiza o código colaborativamente
  socket.on('codeUpdate', newCode => {
    currentCode = newCode;
    socket.broadcast.emit('codeUpdate', currentCode);
  });
  
  // Reset do jogo (código e cronômetro)
  socket.on('resetGame', () => {
    currentCode = "";
    levelStartTime = Date.now();
    io.emit('codeUpdate', currentCode);
    io.emit('timerReset');
  });
  
  // Submete o código: o servidor executa o código em Python e verifica o resultado
  socket.on('submitCode', () => {
    const tempFile = `temp_${uuidv4()}.py`;
    fs.writeFileSync(tempFile, currentCode);
    let cmd = `python3 ${tempFile}`;
    exec(cmd, { timeout: 5000 }, (error, stdout, stderr) => {
      fs.unlinkSync(tempFile);
      if (error) {
        socket.emit('submissionResult', { success: false, message: stderr || error.message });
      } else {
        const output = stdout.trim();
        if (verifyOutput(output, currentLevel.expectedType, currentLevel.expectedValue)) {
          const timeTaken = Date.now() - levelStartTime;
          io.emit('submissionResult', { success: true, message: `Nível ${currentLevel.id} completado em ${(timeTaken/1000).toFixed(1)} segundos!` });
          // Avança para o próximo nível (se houver)
          if (currentLevelIndex < levels.length - 1) {
            currentLevelIndex++;
            currentLevel = levels[currentLevelIndex];
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
          socket.emit('submissionResult', { success: false, message: `Saída incorreta. Esperado (${currentLevel.expectedType}): ${currentLevel.expectedValue}, obtido: ${output}` });
        }
      }
    });
  });
  
  socket.on('disconnect', () => {
    console.log("Cliente desconectado:", socket.id);
  });
});

// Render utilizará a variável PORT definida pelo ambiente
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});