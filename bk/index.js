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

// Estado global compartilhado: código atual e repositório de commits
let currentCode = "// Comece a editar o código aqui...\n";
let repo = { commits: [] };

// Função para adicionar um commit e emitir atualização para os clientes
function addCommit(commit) {
  repo.commits.push(commit);
  io.emit('repoUpdate', repo);
}

// Endpoint para compilar/rodar código Python localmente
app.post('/compile', (req, res) => {
  const { language, code, input } = req.body;
  if (!language || !code) {
    return res.status(400).json({ message: 'Missing language or code.' });
  }
  if (language !== 'python' && language !== 'python3') {
    return res.status(400).json({ message: 'Invalid language. Only python is supported.' });
  }
  // Cria um arquivo temporário com o código
  const tempFileName = `temp_${uuidv4()}.py`;
  fs.writeFileSync(tempFileName, code);
  let command = `python3 ${tempFileName}`;
  let inputFile = null;
  if (input && input.trim() !== '') {
    inputFile = `input_${uuidv4()}.txt`;
    fs.writeFileSync(inputFile, input);
    command = `python3 ${tempFileName} < ${inputFile}`;
  }
  // Executa o comando com timeout para evitar loops infinitos
  exec(command, { timeout: 5000 }, (error, stdout, stderr) => {
    fs.unlinkSync(tempFileName);
    if (inputFile) fs.unlinkSync(inputFile);
    if (error) {
      return res.json({
        id: uuidv4(),
        status: 'SUCCESS',
        compResult: 'F',
        errorCode: 'CE',
        cmpError: stderr || error.message,
        code: code
      });
    }
    return res.json({
      id: uuidv4(),
      status: 'SUCCESS',
      compResult: 'S',
      output: stdout,
      code: code
    });
  });
});

// Configuração do Socket.io para colaboração em tempo real
io.on('connection', socket => {
  console.log("Cliente conectado:", socket.id);
  
  // Ao conectar, envia o código atual e o histórico de commits para o cliente
  socket.emit('updateCode', currentCode);
  socket.emit('repoUpdate', repo);

  // Evento de atualização de código: recebe o código completo do editor
  socket.on('codeUpdate', (newCode) => {
    currentCode = newCode;
    // Propaga para todos os demais clientes (excluindo o emissor)
    socket.broadcast.emit('updateCode', currentCode);
  });

  // Evento de commit: armazena o estado atual do código no repositório
  socket.on('commit', (data) => {
    const commitId = repo.commits.length + 1;
    const commit = {
      id: commitId,
      player: data.player || 'unknown',
      code: currentCode,
      action: 'commit'
    };
    addCommit(commit);
  });

  // Evento de merge: recebe dois códigos (de dois “ramos”) e realiza uma junção simples
  socket.on('merge', (data) => {
    // data: { base, code1, code2 }
    const merged = mergeCodes(data.base, data.code1, data.code2);
    currentCode = merged;
    io.emit('updateCode', currentCode);
    const commitId = repo.commits.length + 1;
    const commit = {
      id: commitId,
      player: 'merge',
      code: merged,
      action: 'merge'
    };
    addCommit(commit);
  });

  // Para deleção de partes de código, basta que o usuário use o editor (a remoção de texto dispara o mesmo evento de atualização)
  
  socket.on('disconnect', () => {
    console.log("Cliente desconectado:", socket.id);
  });
});

// Função simples de merge: junta as linhas não duplicadas dos dois códigos
function mergeCodes(base, code1, code2) {
  const lines1 = code1.split('\n');
  const lines2 = code2.split('\n');
  let mergedLines = [];
  lines1.forEach(line => {
    if (!mergedLines.includes(line)) mergedLines.push(line);
  });
  lines2.forEach(line => {
    if (!mergedLines.includes(line)) mergedLines.push(line);
  });
  return mergedLines.join('\n');
}

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});