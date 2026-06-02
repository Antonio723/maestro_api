import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

// Scraping do Carbon (core.carbon.cars). Porta do crm.py (Selenium) para
// Playwright headless:
//   login -> "Dashboard de Processos" -> "Atualizar Todos"
//   -> espera overlay sumir -> "Extrair para Excel" -> baixa .xlsx
//
// Melhorias sobre o script Python original:
//   - download nativo (waitForEvent) em vez de polling de .crdownload
//   - reuso de sessao via storageState (pula login se o cookie ainda vale)
//   - browser fechado ao fim de cada ciclo (controle de memoria no container)

const TMP = process.env.CARBON_TMP_DIR || os.tmpdir();
const STORAGE_STATE = path.join(TMP, 'carbon-auth.json');
const RAW_FILE = path.join(TMP, 'carbon-raw.xlsx');

const CARBON_URL = process.env.CARBON_URL || 'https://core.carbon.cars/';
// Espera do "Atualizar Todos" (overlay) — etapa pesada, pode levar minutos.
// 30 min por padrão. Configurável por env.
const PROCESS_TIMEOUT_MS = Number(process.env.CARBON_PROCESS_TIMEOUT_MS) || 30 * 60 * 1000;
// Timeout de login/navegação/cliques. Curto de propósito: se a sessão salva
// expirou e caímos na tela de login, queremos FALHAR RÁPIDO para disparar o
// relogin (retry abaixo), em vez de pendurar por 30 min. Configurável por env.
const NAV_TIMEOUT_MS = Number(process.env.CARBON_NAV_TIMEOUT_MS) || 60 * 1000;
// TTL da sessão salva: se o carbon-auth.json for mais velho que isso, ignora
// e faz login novo — evita reusar um cookie prestes a expirar no servidor.
const STORAGE_TTL_MS = Number(process.env.CARBON_STORAGE_TTL_MS) || 6 * 60 * 60 * 1000;

function hasStorageState() {
  try {
    return fs.statSync(STORAGE_STATE).size > 0;
  } catch {
    return false;
  }
}

// Sessão salva ainda "fresca"? Combina existência + tamanho + idade (TTL).
function freshStorageState() {
  try {
    const st = fs.statSync(STORAGE_STATE);
    if (st.size === 0) return false;
    if (Date.now() - st.mtimeMs > STORAGE_TTL_MS) {
      console.log('[CarbonScraper] sessão salva expirou por TTL — login novo');
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function clearStorageState() {
  try {
    fs.rmSync(STORAGE_STATE, { force: true });
    console.log('[CarbonScraper] sessão salva descartada');
  } catch {
    /* arquivo pode nem existir */
  }
}

// A página de login do Carbon tem DOIS forms com os mesmos ids
// (#loginFormUser/#loginFormPassword): o de login e o de "Esqueceu sua senha?".
// Buscar o id solto viola o strict mode do Playwright ("resolved to 2
// elements"). Por isso escopamos tudo ao form de login (o que contém "Bem
// vindo"), garantindo um único elemento.
function loginForm(page) {
  return page.locator('form').filter({ hasText: /Bem vindo/i });
}

async function isLoggedIn(page) {
  const loginField = loginForm(page).locator('#loginFormUser');
  const dashLink = page.getByRole('link', { name: /Dashboard de Processos/i });
  try {
    await Promise.race([
      loginField.waitFor({ state: 'visible', timeout: 8000 }),
      dashLink.waitFor({ state: 'visible', timeout: 8000 }),
    ]);
  } catch {
    /* segue para a verificacao abaixo */
  }
  return (await dashLink.count()) > 0 && (await loginField.count()) === 0;
}

async function doLogin(page) {
  const user = process.env.CARBON_USER;
  const pass = process.env.CARBON_PASS;
  if (!user || !pass) {
    throw new Error('CARBON_USER/CARBON_PASS não configurados no ambiente');
  }
  console.log('[CarbonScraper] efetuando login');
  const form = loginForm(page);
  await form.locator('#loginFormUser').fill(user);
  await form.locator('#loginFormPassword').fill(pass);
  await form.locator("button[type='submit']").click();
  await page
    .getByRole('link', { name: /Dashboard de Processos/i })
    .waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
  console.log('[CarbonScraper] login realizado');
}

/**
 * Executa o fluxo no Carbon e retorna o caminho do .xlsx baixado em /tmp.
 *
 * Tenta primeiro reaproveitando a sessão salva. Se qualquer etapa falhar
 * (sessão expirada no servidor, login caiu no meio do caminho, etc.), descarta
 * o storageState e refaz TODO o fluxo uma vez com login limpo. Isso evita o
 * cenário em que um cookie morto pendura o scraper esperando o "Dashboard".
 * @returns {Promise<string>} caminho absoluto do arquivo bruto
 */
export async function scrapeCarbonExcel() {
  fs.mkdirSync(TMP, { recursive: true });
  try {
    return await runCarbonFlow(freshStorageState());
  } catch (err) {
    console.warn(
      `[CarbonScraper] falha no 1º ciclo (${err?.message || err}); ` +
        'descartando sessão e tentando login limpo'
    );
    clearStorageState();
    return await runCarbonFlow(false);
  }
}

/**
 * @param {boolean} useStored reusar a sessão salva (true) ou forçar login (false)
 */
async function runCarbonFlow(useStored) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(
    useStored && hasStorageState() ? { storageState: STORAGE_STATE } : {}
  );
  const page = await context.newPage();

  try {
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    await page.goto(CARBON_URL, { waitUntil: 'domcontentloaded' });

    if (useStored && (await isLoggedIn(page))) {
      console.log('[CarbonScraper] sessão reaproveitada (sem novo login)');
    } else {
      await doLogin(page);
    }
    // Persiste/atualiza a sessao para o proximo ciclo
    await context.storageState({ path: STORAGE_STATE });

    // Navega para o Dashboard de Processos
    await page.getByRole('link', { name: /Dashboard de Processos/i }).click();

    // Atualizar Todos
    const btnAtualizar = page.getByRole('button', { name: /Atualizar Todos/i });
    await btnAtualizar.waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
    await btnAtualizar.click();
    console.log('[CarbonScraper] "Atualizar Todos" acionado, aguardando processamento');

    // Aguarda o overlay de processamento aparecer e sumir (pode demorar minutos)
    const overlay = page.locator('.overlay');
    try {
      await overlay.waitFor({ state: 'visible', timeout: 10000 });
    } catch {
      /* overlay pode aparecer rapido demais; segue */
    }
    await overlay
      .waitFor({ state: 'hidden', timeout: PROCESS_TIMEOUT_MS })
      .catch(() =>
        console.warn('[CarbonScraper] timeout aguardando overlay; tentando exportar mesmo assim')
      );
    console.log('[CarbonScraper] processamento concluído');

    // Extrair para Excel + captura do download
    const btnExcel = page.getByRole('button', { name: /Extrair para Excel/i });
    await btnExcel.waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: NAV_TIMEOUT_MS }),
      btnExcel.click(),
    ]);

    await download.saveAs(RAW_FILE);
    console.log(`[CarbonScraper] Excel baixado em ${RAW_FILE}`);
    return RAW_FILE;
  } finally {
    await context.close();
    await browser.close();
  }
}
