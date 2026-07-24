fn main() {
    // Cargo doesn't track these as build inputs, so without them a changed icon
    // never gets re-embedded into the executable's Windows resources — the app
    // keeps showing the old taskbar icon even though the source files changed.
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    tauri_build::build()
}
