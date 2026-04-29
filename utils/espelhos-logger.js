import fs from 'fs';
import path from 'path';

const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'espelhos-gerados.txt');

/**
 * Garante que o diretório de logs existe
 */
function ensureLogDirectory() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * Registra a geração de espelhos no arquivo de log
 * @param {Object} dados - Dados da geração
 * @param {string} dados.usuario - Nome ou email do usuário
 * @param {Array} dados.cards - Lista de cards processados
 * @param {boolean} dados.sucesso - Se a operação foi bem-sucedida
 * @param {string} dados.erro - Mensagem de erro (se houver)
 * @param {number} dados.tempoDecorrido - Tempo de processamento em ms
 * @param {Array} dados.arquivosGerados - Lista de arquivos gerados
 */
export function registrarGeracaoEspelhos(dados) {
  try {
    ensureLogDirectory();

    const timestamp = new Date().toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    const separador = '='.repeat(80);
    const status = dados.sucesso ? '✅ SUCESSO' : '❌ ERRO';
    
    let logEntry = `\n${separador}\n`;
    logEntry += `DATA/HORA: ${timestamp}\n`;
    logEntry += `USUÁRIO: ${dados.usuario}\n`;
    logEntry += `STATUS: ${status}\n`;
    logEntry += `CARDS PROCESSADOS (${dados.cards?.length || 0}):\n`;
    
    if (dados.cards && dados.cards.length > 0) {
      dados.cards.forEach((card, index) => {
        logEntry += `  ${index + 1}. ${card.key || card} - ${card.summary || 'Sem título'}\n`;
      });
    }

    if (dados.tempoDecorrido) {
      logEntry += `TEMPO DECORRIDO: ${(dados.tempoDecorrido / 1000).toFixed(2)}s\n`;
    }

    if (dados.arquivosGerados && dados.arquivosGerados.length > 0) {
      logEntry += `ARQUIVOS GERADOS (${dados.arquivosGerados.length}):\n`;
      dados.arquivosGerados.forEach((arquivo, index) => {
        const tamanho = arquivo.tamanho ? ` (${(arquivo.tamanho / 1024).toFixed(2)} KB)` : '';
        logEntry += `  ${index + 1}. ${arquivo.nome}${tamanho}\n`;
      });
    }

    if (!dados.sucesso && dados.erro) {
      logEntry += `ERRO: ${dados.erro}\n`;
    }

    logEntry += `${separador}\n`;

    // Adiciona ao arquivo de log
    fs.appendFileSync(LOG_FILE, logEntry, 'utf8');
    
    console.log('📝 Log de geração de espelhos registrado com sucesso');
    return true;
  } catch (error) {
    console.error('❌ Erro ao registrar log de espelhos:', error);
    return false;
  }
}

/**
 * Obtém todos os logs de espelhos gerados
 * @returns {string} Conteúdo do arquivo de log
 */
export function obterLogsEspelhos() {
  try {
    if (!fs.existsSync(LOG_FILE)) {
      return 'Nenhum log de espelhos encontrado.';
    }

    return fs.readFileSync(LOG_FILE, 'utf8');
  } catch (error) {
    console.error('❌ Erro ao ler logs de espelhos:', error);
    return 'Erro ao carregar logs.';
  }
}

/**
 * Limpa o arquivo de logs (usar com cuidado!)
 */
export function limparLogsEspelhos() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      fs.unlinkSync(LOG_FILE);
      console.log('🗑️ Arquivo de logs limpo com sucesso');
      return true;
    }
    return true;
  } catch (error) {
    console.error('❌ Erro ao limpar logs:', error);
    return false;
  }
}
