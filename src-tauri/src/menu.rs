use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Manager, Runtime};

/// Builds the native application menu. Custom items use `menu.*` ids, which
/// `on_menu_event` (src-tauri/src/lib.rs) forwards to the frontend as
/// "menu-action" events; predefined items keep their native behavior (undo,
/// copy/paste, about, quit, window controls — without an Edit submenu the
/// standard ⌘Z/⌘C/⌘V shortcuts would stop working once a custom menu is set).
pub fn build_menu<R: Runtime, M: Manager<R>>(manager: &M) -> tauri::Result<Menu<R>> {
    let settings = MenuItem::with_id(manager, "menu.settings", "设置…", true, Some("CmdOrCtrl+,"))?;
    let app_menu = Submenu::with_items(
        manager,
        "Opus",
        true,
        &[
            &PredefinedMenuItem::about(manager, Some("关于 Opus"), None)?,
            &PredefinedMenuItem::separator(manager)?,
            &settings,
            &PredefinedMenuItem::separator(manager)?,
            &PredefinedMenuItem::quit(manager, Some("退出 Opus"))?,
        ],
    )?;

    let new_document = MenuItem::with_id(manager, "menu.new", "新建", true, Some("CmdOrCtrl+N"))?;
    let open_files = MenuItem::with_id(
        manager,
        "menu.open_files",
        "打开文件",
        true,
        Some("CmdOrCtrl+O"),
    )?;
    let open_folder = MenuItem::with_id(
        manager,
        "menu.open_folder",
        "打开文件夹",
        true,
        Some("CmdOrCtrl+Shift+O"),
    )?;
    let save = MenuItem::with_id(manager, "menu.save", "保存", true, Some("CmdOrCtrl+S"))?;
    let save_as = MenuItem::with_id(
        manager,
        "menu.save_as",
        "另存为…",
        true,
        Some("CmdOrCtrl+Shift+S"),
    )?;
    let close_tab = MenuItem::with_id(
        manager,
        "menu.close_tab",
        "关闭标签页",
        true,
        Some("CmdOrCtrl+W"),
    )?;
    let file_menu = Submenu::with_items(
        manager,
        "文件",
        true,
        &[
            &new_document,
            &open_files,
            &open_folder,
            &PredefinedMenuItem::separator(manager)?,
            &save,
            &save_as,
            &PredefinedMenuItem::separator(manager)?,
            &close_tab,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        manager,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(manager, Some("撤销"))?,
            &PredefinedMenuItem::redo(manager, Some("重做"))?,
            &PredefinedMenuItem::separator(manager)?,
            &PredefinedMenuItem::cut(manager, Some("剪切"))?,
            &PredefinedMenuItem::copy(manager, Some("复制"))?,
            &PredefinedMenuItem::paste(manager, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(manager, Some("全选"))?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        manager,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(manager, Some("最小化"))?,
            &PredefinedMenuItem::maximize(manager, Some("缩放"))?,
            &PredefinedMenuItem::separator(manager)?,
            &PredefinedMenuItem::fullscreen(manager, Some("进入全屏"))?,
        ],
    )?;

    Menu::with_items(manager, &[&app_menu, &file_menu, &edit_menu, &window_menu])
}
