import * as p from '@clack/prompts';
import chalk from 'chalk';
import path from 'path';
import { access, writeFile } from 'node:fs/promises';
import { generateTemplate, getConfigFileName } from '../utils/template';

export async function initCommand(): Promise<void> {
  p.intro(chalk.blue('🚀 Initializing LLM Proxy'));

  try {
    const cwd = process.cwd();
    const configFileName = getConfigFileName();
    const configPath = path.join(cwd, configFileName);

    const configExists = await access(configPath).then(() => true).catch(() => false);
    if (configExists) {
      const shouldOverwrite = await p.confirm({
        message: `${configFileName} already exists. Overwrite?`,
      });

      if (p.isCancel(shouldOverwrite) || !shouldOverwrite) {
        p.outro(chalk.gray('Cancelled'));
        process.exit(0);
      }
    }

    const s = p.spinner();
    s.start(`Generating ${configFileName}...`);

    const template = await generateTemplate();
    await writeFile(configPath, template, 'utf-8');

    s.stop(`✅ ${configFileName} created`);

    p.note(
      '1. Edit model.jsonc in your project root\n' +
      '2. Update baseUrl, apiKey, and models\n' +
      '3. Configure rate limits as needed\n' +
      '4. Run: llm-proxy start',
      '📋 Configuration Instructions'
    );

    p.outro(chalk.green(`✅ LLM Proxy initialized! Run "llm-proxy start"`));
  } catch (error: any) {
    p.outro(chalk.red(`❌ ${error.message || 'Failed to initialize'}`));
    process.exit(1);
  }
}
