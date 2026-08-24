import { Scene, Node, Label, ColorRect, Sprite, Input, assetCache, AssetItem, createPlatform } from 'noonengine';
import { theme } from '../config/theme';
import { rules } from '../config/rules';
import { BoardView } from './BoardView';
import { debugLayouts } from './debugLayouts';

export const GAME_WIDTH = 720;
export const GAME_HEIGHT = 1280;

const HUD_HEIGHT = 140;
const TARGET_ICON_SIZE = 28;
const TARGET_ROW_SPACING = 30;

/**
 * Placeholder — this template has no real store/pitch link yet. Swap for the
 * actual destination before shipping to any real ad network; `triggerCTA`
 * (see `AI_WORKFLOW.md`'s platform section) is what makes this safe to leave
 * wired in the meantime — it's a no-op on every target until a real network
 * build calls it.
 */
const CTA_URL = 'https://example.com/download';

export class GameScene extends Scene {

    private platform: ReturnType<typeof createPlatform>;
    private atlas: any;
    private scoreLabel!: Label;
    private movesLabel!: Label;
    /** typeId -> its HUD count label, only built in `'collect'` mode. */
    private targetLabels: Map<number, Label> = new Map();
    /** Score-mode's fill bar, only built in `'score'` mode. */
    private targetFill: Node | null = null;
    private targetFillTrackWidth = 0;
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
        this.atlas = assetCache.getAsset(theme.tilesAtlasKey);
        this._buildHud();

        const tileSize = 80;
        const boardWidth = rules.board.cols * tileSize;
        const boardHeight = rules.board.rows * tileSize;
        const left = (GAME_WIDTH - boardWidth) / 2;
        const availableHeight = GAME_HEIGHT - HUD_HEIGHT;
        const top = GAME_HEIGHT - HUD_HEIGHT - (availableHeight - boardHeight) / 2;

        // `?layout=<name>` (see debugLayouts.ts) loads a fixed board instead
        // of the normal random one — for manually testing a scenario that's
        // rare to hit by chance (a swap away from a 5-match, two specials
        // already adjacent). No param, or an unknown name, plays normally.
        const layoutName = new URLSearchParams(location.search).get('layout');
        const debugLayout = layoutName ? debugLayouts[layoutName] : undefined;
        if (layoutName && !debugLayout) {
            console.warn(`[GameScene] Unknown ?layout=${layoutName} — known layouts: ${Object.keys(debugLayouts).join(', ')}`);
        }

        this.boardView = new BoardView(this, { left, top, tileSize }, debugLayout);
        this.boardView.onScoreChange = score => this._onScoreChange(score);
        this.boardView.onMovesChange = moves => { this.movesLabel.text = `Moves: ${moves}`; };
        this.boardView.onCollectChange = remaining => this._onCollectChange(remaining);
        this.boardView.onGameOver = won => this._showGameOver(won);

        this.platform.notifyReady();
    }

    private _onScoreChange(score: number): void {
        this.scoreLabel.text = `Score: ${score}`;
        if (rules.winCondition.mode !== 'score' || !this.targetFill) return;
        const progress = Math.max(0, Math.min(1, score / rules.winCondition.targetScore));
        this.targetFill.width = this.targetFillTrackWidth * progress;
    }

    private _onCollectChange(remaining: Map<number, number>): void {
        for (const [typeId, label] of this.targetLabels) {
            label.text = `${Math.max(0, remaining.get(typeId) ?? 0)}`;
        }
    }

    private _buildHud(): void {
        const barNode = new Node(GAME_WIDTH / 2, GAME_HEIGHT - HUD_HEIGHT / 2);
        barNode.width = GAME_WIDTH;
        barNode.height = HUD_HEIGHT;
        const rect = barNode.addComponent(ColorRect);
        rect.color = '#22223a';
        this.addChild(barNode);

        // Left column — moves.
        const movesNode = new Node(40, GAME_HEIGHT - HUD_HEIGHT / 2);
        movesNode.anchorX = 0;
        this.movesLabel = movesNode.addComponent(Label);
        this.movesLabel.text = `Moves: ${rules.winCondition.moveLimit}`;
        this.movesLabel.fontSize = 26;
        this.movesLabel.color = '#ffffff';
        this.addChild(movesNode);

        // Center column — score.
        const scoreNode = new Node(GAME_WIDTH / 2, GAME_HEIGHT - HUD_HEIGHT / 2);
        scoreNode.anchorX = 0.5;
        this.scoreLabel = scoreNode.addComponent(Label);
        this.scoreLabel.text = 'Score: 0';
        this.scoreLabel.fontSize = 26;
        this.scoreLabel.color = '#ffffff';
        this.addChild(scoreNode);

        // Right column — target, shape depends on win-condition mode.
        if (rules.winCondition.mode === 'score') {
            this._buildScoreTargetColumn();
        } else {
            this._buildCollectTargetColumn(rules.winCondition.targets);
        }
    }

    private _buildScoreTargetColumn(): void {
        const trackWidth = 180;
        const centerX = GAME_WIDTH - 40 - trackWidth / 2;
        const centerY = GAME_HEIGHT - HUD_HEIGHT / 2;

        const labelNode = new Node(GAME_WIDTH - 40, centerY - 18);
        labelNode.anchorX = 1;
        const label = labelNode.addComponent(Label);
        label.text = 'Target';
        label.fontSize = 18;
        label.color = '#cccccc';
        this.addChild(labelNode);

        const trackNode = new Node(centerX, centerY + 6);
        trackNode.width = trackWidth;
        trackNode.height = 14;
        const track = trackNode.addComponent(ColorRect);
        track.color = '#3a3a55';
        this.addChild(trackNode);

        const fillNode = new Node(GAME_WIDTH - 40 - trackWidth, centerY + 6);
        fillNode.anchorX = 0;
        fillNode.width = 0;
        fillNode.height = 14;
        const fill = fillNode.addComponent(ColorRect);
        fill.color = '#ffd24d';
        this.addChild(fillNode);

        this.targetFill = fillNode;
        this.targetFillTrackWidth = trackWidth;
    }

    private _buildCollectTargetColumn(targets: { typeId: number; count: number }[]): void {
        const centerY = GAME_HEIGHT - HUD_HEIGHT / 2;
        // World Y is up-positive (screen Y is flipped from it) — start from the
        // topmost row's Y and step *down* per row so the array's own order
        // reads top-to-bottom on screen, matching how it reads in `rules.ts`.
        const topRowY = centerY + ((targets.length - 1) * TARGET_ROW_SPACING) / 2;

        targets.forEach((target, i) => {
            const rowY = topRowY - i * TARGET_ROW_SPACING;

            const iconNode = new Node(GAME_WIDTH - 92, rowY);
            const sprite = iconNode.addComponent(Sprite);
            sprite.spriteFrame = this.atlas.getFrame(theme.tileTypes[target.typeId].spriteKey);
            const scale = TARGET_ICON_SIZE / Math.max(iconNode.width, iconNode.height);
            iconNode.scaleX = scale;
            iconNode.scaleY = scale;
            this.addChild(iconNode);

            const countNode = new Node(GAME_WIDTH - 40, rowY);
            countNode.anchorX = 1;
            const label = countNode.addComponent(Label);
            label.text = `${target.count}`;
            label.fontSize = 22;
            label.color = '#ffffff';
            this.addChild(countNode);

            this.targetLabels.set(target.typeId, label);
        });
    }

    private _showGameOver(won: boolean): void {
        const overlay = new Node(GAME_WIDTH / 2, GAME_HEIGHT / 2);
        overlay.width = GAME_WIDTH;
        overlay.height = 200;
        const bg = overlay.addComponent(ColorRect);
        bg.color = won ? '#1e5631' : '#5a1e1e';
        this.addChild(overlay);

        const labelNode = new Node(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 40);
        const label = labelNode.addComponent(Label);
        label.text = won ? 'You Win!' : 'Game Over';
        label.fontSize = 48;
        label.color = '#ffffff';
        this.addChild(labelNode);

        this._showEndCard();
    }

    /**
     * The ad-creative end card: a CTA prompt and a download control whose
     * destination is never rendered as visible text — `platform.triggerCTA`
     * (see `AI_WORKFLOW.md`) is the only thing that ever sees `CTA_URL`. No
     * close/cross button here — every playable-ad network researched
     * (Google, Meta, Unity/AppLovin) draws that in its own host container,
     * not the creative; see AGENTS.md.
     *
     * Built as a plain `Node` + `ColorRect` + `Label` with a raw
     * `Input.CLICK` listener — the same pattern `BoardView`'s grid cells
     * already use — rather than the `Button` component, to keep this
     * template's component footprint (and so its trimmed bundle size) small.
     */
    private _showEndCard(): void {
        const messageNode = new Node(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 30);
        const message = messageNode.addComponent(Label);
        message.text = 'To play this game click the download link';
        message.fontSize = 22;
        message.color = '#ffffff';
        this.addChild(messageNode);

        const buttonWidth = 260;
        const buttonHeight = 64;
        const buttonNode = new Node(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 90);
        buttonNode.width = buttonWidth;
        buttonNode.height = buttonHeight;
        const buttonBg = buttonNode.addComponent(ColorRect);
        buttonBg.color = '#ffd24d';
        this.addChild(buttonNode);

        const captionNode = new Node(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 90);
        const caption = captionNode.addComponent(Label);
        caption.text = 'Download';
        caption.fontSize = 26;
        caption.color = '#1e1e1e';
        this.addChild(captionNode);

        buttonNode.on(Input.CLICK, () => this.platform.triggerCTA(CTA_URL), this);
    }

    update(_dt: number): void { }
}
