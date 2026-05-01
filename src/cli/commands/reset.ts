import * as p from '@clack/prompts';
import chalk from 'chalk';
import path from 'path';
import { generateTemplate, getConfigFileName } from '../utils/template';

export async function resetCommand(): Promise<void> {
  p.intro(chalk.blue('🔄 Resetting LLM Proxy'));

  try {
    const skipPrompts = process.argv.includes('--skip-prompts');
    let shouldReset = skipPrompts;

    if (!skipPrompts) {
      const confirm = await p.confirm({
        message: 'Reset model.jsonc to initial template?',
      });

      if (p.isCancel(confirm)) {
        p.outro(chalk.gray('Cancelled'));
        process.exit(0);
      }

      shouldReset = !!confirm;
    }

    if (!shouldReset) {
      p.outro(chalk.gray('Cancelled'));
      process.exit(0);
    }

    const s = p.spinner();
    s.start('Resetting configuration...');

    // Try to clear cache if possible
    try {
      const { CACHE } = await import('../../state');
      await CACHE.clearCache();
    } catch (err) {
      // Cache might not be initialized
    }

    const cwd = process.cwd();
    const configFileName = getConfigFileName();
    const configPath = path.join(cwd, configFileName);
    
    const template = await generateTemplate();
    await Bun.write(configPath, template);

    s.stop('✅ Configuration reset');

    p.note(
      '1. Edit model.jsonc with your configuration\n' +
      '2. Run: llm-proxy start',
      '💡 Next Steps'
    );

    p.outro(chalk.green('✅ Ready for new configuration'));
  } catch (error: any) {
    p.outro(chalk.red(`❌ ${error.message || 'Failed to reset'}`));
    process.exit(1);
  }
}
