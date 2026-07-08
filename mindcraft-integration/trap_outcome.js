// TrapStreet integration shim: at task end, write an outcome JSON matching the
// obtain_diamond task's judge contract (inventory -> tech-tree milestones).
// Added for the minecraft-obtain-diamond task; not part of upstream Mindcraft.
import { writeFileSync } from 'fs';

const IRON_PROOF = ['iron_ingot', 'iron_pickaxe', 'iron_axe', 'iron_sword', 'iron_shovel', 'iron_hoe', 'iron_block'];

export function writeTrapOutcome(agent, taskResult) {
    try {
        const bot = agent.bot;
        const items = bot.inventory ? bot.inventory.items() : [];
        const names = new Set(items.map(i => i.name));
        const have = (n) => names.has(n);
        const success = !!(taskResult && /successful/i.test(taskResult.message || ''));
        const diamondCount = items.filter(i => i.name === 'diamond').reduce((s, i) => s + i.count, 0);
        const obtained = success || diamondCount > 0;

        const ms = [];
        if (have('wooden_pickaxe')) ms.push('wooden_pickaxe');
        if (have('stone_pickaxe')) ms.push('stone_pickaxe');
        if (IRON_PROOF.some(have)) ms.push('iron_ingot');
        if (have('iron_pickaxe')) ms.push('iron_pickaxe');
        if (obtained || have('diamond')) ms.push('diamond');

        const outcome = {
            obtained,
            item: 'diamond',
            count: obtained ? Math.max(1, diamondCount) : diamondCount,
            ticks: bot.time ? bot.time.age : null,
            inventory: items.map((i) => `${i.name} x${i.count}`),
            milestones: ms,
            mindcraft_score: taskResult ? taskResult.score : null,
            seed: process.env.TRAP_SEED || null,
            mc_version: bot.version || null,
            video: process.env.TRAP_VIDEO || '', // filled in by the recorder after muxing
        };
        writeFileSync(process.env.TRAP_OUTCOME || './trap_outcome.json', JSON.stringify(outcome, null, 2));
        console.log('[trap] wrote outcome:', JSON.stringify(outcome));
    } catch (e) {
        console.log('[trap] failed to write outcome:', e && e.message);
    }
}
