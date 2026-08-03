//! TeXButler Tauri entry point. Kept minimal: all logic lives in the lib.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    texbutler_lib::run();
}
