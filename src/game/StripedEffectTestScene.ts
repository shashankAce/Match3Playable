/**
 * Isolated test scene for the striped-tile activation effect — bypasses
 * `GameScene`'s HUD/win-condition wiring entirely so the effect can be
 * checked on its own. Loads one of `debugLayouts.ts`'s
 * `striped-h-4match`/`striped-v-4match` layouts (`?dir=h`/`?dir=v` in the
 * URL, default `h`), each one swap away from a 4-match. Reuses the real
 * `Board`/`BoardView` production code — this is testing the actual effect
 * the live game shows, not a mock of it.
 *
 * Not wired into `src/index.ts` by default gameplay — only runs via
 * `?scene=striped-test` (see `src/index.ts`).
 */
import { Scene, Node, Label, assetCache, AssetItem, createPlatform } from 'noonengine';
import { theme } from '../config/theme';
import { rules } from '../config/rules';
import { BoardView } from './BoardView';
import { debugLayouts } from './debugLayouts';

export const GAME_WIDTH = 720;
export const GAME_HEIGHT = 1280;

const INSTRUCTION_AREA_HEIGHT = 200;

export class StripedEffectTestScene extends Scene {

    private platform: ReturnType<typeof createPlatform>;
    private boardView!: BoardView;

    constructor(platform: ReturnType<typeof createPlatform>) {
        super();
        this.platform = platform;
    }

    onLoad(): void {
        const list: AssetItem[] = [
            { src: theme.tilesAtlasSrc, type: 'atlas', alias: theme.tilesAtlasKey },
        ];
        assetCache.preloadAssets(list, p => this.platform.reportProgress(p)).then(() => this._build());
    }

    private _build(): void {
        const dir = new URLSearchParams(location.search).get('dir') === 'v' ? 'v' : 'h';
        const debugLayout = debugLayouts[dir === 'v' ? 'striped-v-4match' : 'striped-h-4match'];

        // World Y is up-positive (screen Y is flipped from it) — a world-y
        // close to GAME_HEIGHT renders near the top of the screen, same
        // convention `GameScene`'s HUD bar uses.
        const instrNode = new Node(GAME_WIDTH / 2, GAME_HEIGHT - INSTRUCTION_AREA_HEIGHT / 2);
        const instr = instrNode.addComponent(Label);
        // A match's resulting tile is perpendicular to the match itself (see
        // Board.resolve()'s doc), so a vertical match's beam covers the row,
        // and a horizontal match's beam covers the column.
        instr.text = dir === 'v'
            ? 'Step 1: swap (2,2)<->(2,3) to make a vertical 4-match.\nStep 2: swap the new striped tile with any neighbor.\nExpected: a beam covers the ENTIRE row.'
            : 'Step 1: swap (4,2)<->(5,2) to make a horizontal 4-match.\nStep 2: swap the new striped tile with any neighbor.\nExpected: a beam covers the ENTIRE column.';
        instr.fontSize = 22;
        instr.color = '#ffffff';
        this.addChild(instrNode);

        const tileSize = 80;
        const boardWidth = rules.board.cols * tileSize;
        const boardHeight = rules.board.rows * tileSize;
        const left = (GAME_WIDTH - boardWidth) / 2;
        const availableHeight = GAME_HEIGHT - INSTRUCTION_AREA_HEIGHT;
        const top = GAME_HEIGHT - INSTRUCTION_AREA_HEIGHT - (availableHeight - boardHeight) / 2;

        this.boardView = new BoardView(this, { left, top, tileSize }, debugLayout);

        this.platform.notifyReady();
    }

    update(_dt: number): void { }
}
