import { Neovim } from '@chemzqm/neovim';
import {
  CancellationTokenSource,
  Disposable,
} from 'vscode-languageserver-protocol';
import {
  Documentation,
  snippetManager,
  workspace,
  disposeAll,
  Env,
  FloatBuffer,
  Buffer,
} from 'coc.nvim';
import { WindowConfig } from 'coc.nvim/lib/model/floatFactory';
import {
  debounce,
  Cancellable,
  delay,
  supportedFloat,
  asyncCatchError,
} from '../util';
import { Explorer } from '../explorer';
import { BufferHighlight } from '@chemzqm/neovim';
import { log, onError } from '../logger';
import { argOptions } from '../argOptions';
import { onBufEnter, onEvents } from '../events';

// factory class for floating window
export class FloatingFactory3 implements Disposable {
  private targetBufnr!: number;
  private winid = 0;
  private bufnr = 0;
  private disposables: Disposable[] = [];
  private floatBuffer!: FloatBuffer;
  private tokenSource: CancellationTokenSource | undefined;
  private alignTop = false;
  private pumAlignTop = false;
  private onCursorMoved!: Cancellable<() => void>;
  constructor(
    private explorer: Explorer,
    private nvim: Neovim,
    private env: Env,
    private preferTop = false,
    private maxHeight = 999,
    private maxWidth?: number,
    private autoHide = true,
  ) {
    if (!supportedFloat()) {
      return;
    }
    // @ts-ignore
    this.floatBuffer = new FloatBuffer(nvim);
    this.onCursorMoved = debounce(
      300,
      asyncCatchError(() => this._onCursorMoved()),
    );
    this.explorer.context.subscriptions.push(
      onBufEnter(
        async (bufnr) => {
          if (bufnr === this.bufnr || bufnr === this.targetBufnr) {
            return;
          }
          await this.close();
        },
        200,
        this.disposables,
      ),
      onEvents(
        'MenuPopupChanged',
        async (ev, cursorline) => {
          const pumAlignTop = (this.pumAlignTop = cursorline > ev.row);
          if (pumAlignTop === this.alignTop) {
            await this.close();
          }
        },
        undefined,
        this.disposables,
      ),
      onEvents('CursorMoved', this.onCursorMoved, undefined, this.disposables),
      onEvents('CursorMovedI', this.onCursorMoved, undefined, this.disposables),
    );
  }

  private async _onCursorMoved(): Promise<void> {
    const { bufnr, insertMode } = workspace;
    if (bufnr === this.bufnr) {
      return;
    }
    if (this.autoHide) {
      await this.close();
      return;
    }
    if (!insertMode || bufnr !== this.targetBufnr) {
      await this.close();
      return;
    }
  }

  public get buffer(): Buffer {
    return this.nvim.createBuffer(this.bufnr);
  }

  private get columns(): number {
    return this.env.columns;
  }

  private get lines(): number {
    return this.env.lines - this.env.cmdheight - 1;
  }

  public async getWindowConfig(
    docs: Documentation[],
    win_position: [number, number],
  ): Promise<WindowConfig | void> {
    const { columns, preferTop, lines, nvim } = this;
    let alignTop = false;
    const [winRow] = win_position;
    const position = await this.explorer.args.value(argOptions.position);
    const isFloating = position === 'floating';
    const enabledFloatingBorder = this.explorer.config.get(
      'floating.border.enable',
    );
    const containerWin =
      isFloating && enabledFloatingBorder
        ? await this.explorer.floatingBorderWin
        : await this.explorer.win;
    if (!containerWin) {
      return;
    }
    const containerWidth = await containerWin.width;
    const maxWidth = columns - containerWidth - 1;
    let maxHeight = alignTop ? winRow : lines - winRow - 1;
    maxHeight = Math.min(maxHeight, this.maxHeight || lines);
    const {
      width: previewWidth,
      height: previewHeight,
      // @ts-ignore
    } = FloatBuffer.getDimension(docs, maxWidth, maxHeight);

    if (!preferTop) {
      if (lines - winRow < previewHeight && winRow > previewHeight) {
        alignTop = true;
      }
    } else {
      if (winRow >= previewHeight || winRow >= lines - winRow) {
        alignTop = true;
      }
    }
    this.alignTop = alignTop;

    const explorerLineIndex = this.explorer.currentLineIndex;
    const view: {
      topline: number;
      leftcol: number;
      lnum: number;
      col: number;
    } = await nvim.call('winsaveview', []);
    let col = 0;
    let row =
      explorerLineIndex -
      view.topline +
      1 +
      (alignTop ? -previewHeight + 1 : 0);
    if (position === 'left') {
      col = containerWidth;
    } else if (position === 'right') {
      col = columns - previewWidth - containerWidth;
    } else if (position === 'floating') {
      const {
        row: floatingRow,
        col: floatingCol,
      } = (await nvim.call('nvim_win_get_config', [
        containerWin.id,
      ])) as WindowConfig;
      const floatingPosition = await this.explorer.args.value(
        argOptions.floatingPosition,
      );
      row += floatingRow;
      if (floatingPosition === 'left-center') {
        col = floatingCol + containerWidth;
      } else if (floatingPosition === 'right-center') {
        col = floatingCol - previewWidth;
      } else {
        return;
      }
    }

    return {
      row,
      col,
      width: previewWidth,
      height: previewHeight,
      relative: 'editor',
    };
  }

  public async create(
    docs: Documentation[],
    highlights: BufferHighlight[] = [],
    allowSelection = false,
  ): Promise<void> {
    if (!supportedFloat()) {
      // eslint-disable-next-line no-restricted-syntax
      log('error', 'Floating window & textprop not supported!');
      return;
    }
    this.onCursorMoved.cancel();
    if (docs.length === 0 || docs.every((d) => d.content.length === 0)) {
      await this.close();
      return;
    }
    this.cancel();
    try {
      await this.createPopup(docs, highlights, allowSelection);
    } catch (e) {
      // eslint-disable-next-line no-restricted-syntax
      log('error', `Error on create popup: ${e.message}`);
      await this.close();
    }
  }

  public async createPopup(
    docs: Documentation[],
    highlights: BufferHighlight[],
    allowSelection = false,
  ): Promise<void> {
    const tokenSource = (this.tokenSource = new CancellationTokenSource());
    const token = tokenSource.token;
    const { nvim, alignTop, pumAlignTop, floatBuffer } = this;
    // get options
    const arr = await this.nvim.call('coc#util#get_float_mode', [
      allowSelection,
      alignTop,
      pumAlignTop,
    ]);
    if (!arr || token.isCancellationRequested) {
      return;
    }
    if (docs.length === 0 || docs.every((d) => d.content.length === 0)) {
      await this.close();
      return;
    }
    const [mode, targetBufnr, win_position] = arr;
    this.targetBufnr = targetBufnr;
    const config = await this.getWindowConfig(docs, win_position);
    if (!config) {
      return;
    }
    if (config.width <= 0 || config.height <= 0 || isNaN(config.height)) {
      await this.close();
      return;
    }
    // calculat highlights
    await floatBuffer.setDocuments(docs, config.width);
    if (token.isCancellationRequested) {
      return;
    }
    // create window
    const res = await this.nvim.call('coc#util#create_float_win', [
      this.winid,
      this.bufnr,
      config,
    ]);
    if (!res || token.isCancellationRequested) {
      return;
    }
    const winid = (this.winid = res[0]);
    const bufnr = (this.bufnr = res[1]);
    const showBottom = alignTop && docs.length > 1;
    nvim.pauseNotification();
    if (workspace.isNvim) {
      nvim.command(`noa call win_gotoid(${this.winid})`, true);
      // @ts-ignore
      this.floatBuffer.setLines(bufnr);
      for (const hl of highlights) {
        this.buffer.addHighlight(hl).catch(onError);
      }
      nvim.command(`noa normal! ${showBottom ? 'G' : 'gg'}0`, true);
      nvim.command('noa wincmd p', true);
    } else {
      // no need to change cursor position
      // @ts-ignore
      this.floatBuffer.setLines(bufnr, winid);
      for (const hl of highlights) {
        this.buffer.addHighlight(hl).catch(onError);
      }
      nvim.call(
        'win_execute',
        [winid, `noa normal! ${showBottom ? 'G' : 'gg'}0`],
        true,
      );
      nvim.command('redraw', true);
    }
    const [, err] = await nvim.resumeNotification();
    if (err) {
      throw new Error(`Error on ${err[0]}: ${err[1]} - ${err[2]}`);
    }
    if (mode === 's' && !token.isCancellationRequested) {
      await snippetManager.selectCurrentPlaceholder(false);
      await delay(50);
    }
    this.onCursorMoved.cancel();
  }

  /**
   * Close float window
   */
  public async close(): Promise<void> {
    const { winid } = this;
    this.cancel();
    if (winid) {
      this.nvim.pauseNotification();
      this.nvim.call('coc#util#close_win', [winid], true);
      if (workspace.isVim) {
        this.nvim.command('redraw', true);
      }
      this.winid = 0;
      await this.nvim.resumeNotification();
    }
  }

  private cancel(): void {
    const { tokenSource } = this;
    if (tokenSource) {
      tokenSource.cancel();
      this.tokenSource = undefined;
    }
  }

  public dispose(): void {
    if (this.tokenSource) {
      this.tokenSource.cancel();
    }
    disposeAll(this.disposables);
  }
}
