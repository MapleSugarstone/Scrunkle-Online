// What the page keeps between visits so a player's progress survives a reload.

/**
 * The stage lists that hold the player's progress and settings. `!SAVE_DATA` is the whole save, the one the game's
 * save codes hold. The settings and keybinds lists are kept as well, because the settings menu changes them
 * without copying them into `!SAVE_DATA`.
 */
export const SAVE_LISTS = ['!SAVE_DATA', '!Global_GameSettings', '!G_Keybinds'];

/** Stage variables to keep. This game keeps its progress in lists only. */
export const SAVE_VARS: string[] = [];
