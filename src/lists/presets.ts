import { BasicList, Neovim } from 'coc.nvim';
import { getPresets } from '../presets';
import { configLocal } from '../config';
import { onError } from '../util';

export class PresetList extends BasicList {
  readonly name = 'explPresets';
  readonly defaultAction = 'do';
  public description = 'explorer presets';

  constructor(nvim: Neovim) {
    super(nvim);

    this.addAction('do', async (item) => {
      this.nvim
        .command(`CocCommand explorer --preset ${item.data.name}`)
        .catch(onError);
    });
  }

  async loadItems(_context: any) {
    const presets = await getPresets(configLocal());
    return Object.keys(presets).map((name) => ({
      label: name,
      data: {
        name,
      },
    }));
  }

  doHighlight() {
    const { nvim } = this;
    nvim.pauseNotification();
    nvim.command('syntax match CocExplorerPreset /.*/', true);
    nvim.command('highlight default link CocExplorerPreset PreProc', true);
    nvim.resumeNotification().catch(onError);
  }
}
