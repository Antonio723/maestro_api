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
const PROCESS_TIMEOUT_MS = Number(process.env.CARBON_PROCESS_TIMEOUT_MS || 240000);

function hasStorageState() {
  try {
    return fs.statSync(STORAGE_STATE).size > 0;
  } catch {
    return false;
  }
}

async function isLoggedIn(page) {
  const loginField = page.locator('#loginFormUser');
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
  await page.locator('#loginFormUser').fill(user);
  await page.locator('#loginFormPassword').fill(pass);
  await page.locator("button[type='submit']").click();
  await page
    .getByRole('link', { name: /Dashboard de Processos/i })
    .waitFor({ state: 'visible', timeout: 30000 });
  console.log('[CarbonScraper] login realizado');
}

/**
 * Executa o fluxo no Carbon e retorna o caminho do .xlsx baixado em /tmp.
 * @returns {Promise<string>} caminho absoluto do arquivo bruto
 */
export async function scrapeCarbonExcel() {
  fs.mkdirSync(TMP, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(
    hasStorageState() ? { storageState: STORAGE_STATE } : {}
  );
  const page = await context.newPage();

  try {
    page.setDefaultTimeout(15000);
    await page.goto(CARBON_URL, { waitUntil: 'domcontentloaded' });

    if (await isLoggedIn(page)) {
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
    await btnAtualizar.waitFor({ state: 'visible', timeout: 30000 });
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
    await btnExcel.waitFor({ state: 'visible', timeout: 30000 });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 120000 }),
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
