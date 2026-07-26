use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::Mutex;
use tauri::Manager;
use walkdir::WalkDir;

const IMG_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "webp", "ico", "tiff", "tif", "svg", "avif"];

fn is_image(path: &Path) -> bool {
    path.is_file()
        && path.extension()
            .and_then(|e| e.to_str())
            .map(|e| IMG_EXTS.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false)
}

#[derive(Serialize, Clone)]
struct ImageFile {
    path: String,
    name: String,
}

#[derive(Serialize)]
struct ImageInfo {
    width: u32,
    height: u32,
    size: u64,
}

#[derive(Serialize, Deserialize)]
struct RecentPaths {
    paths: Vec<String>,
}

#[derive(Serialize, Clone, Default)]
struct ExifData {
    camera: Option<String>,
    software: Option<String>,
    date_time: Option<String>,
    aperture: Option<String>,
    shutter: Option<String>,
    iso: Option<i64>,
    focal_length: Option<String>,
    flash: Option<String>,
    orientation: Option<String>,
    gps_lat: Option<f64>,
    gps_lon: Option<f64>,
}

struct ExifCache {
    map: HashMap<String, (u64, ExifData)>,
}

impl ExifCache {
    fn new() -> Self {
        Self { map: HashMap::new() }
    }

    fn get(&self, path: &str, mtime: u64) -> Option<&ExifData> {
        self.map.get(path).and_then(|(t, data)| {
            if *t == mtime { Some(data) } else { None }
        })
    }

    fn insert(&mut self, path: String, mtime: u64, data: ExifData) {
        self.map.insert(path, (mtime, data));
    }
}

fn recent_file(app: &tauri::AppHandle) -> std::path::PathBuf {
    let p = app.path().app_local_data_dir().unwrap();
    fs::create_dir_all(&p).ok();
    p.join("recent.json")
}

fn thumb_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    let p = app.path().app_cache_dir().unwrap();
    let d = p.join("thumbs");
    fs::create_dir_all(&d).ok();
    d
}

fn thumb_path(cache: &std::path::PathBuf, src: &str) -> std::path::PathBuf {
    let mut h = DefaultHasher::new();
    src.hash(&mut h);
    let name = format!("{:x}.jpg", h.finish());
    cache.join(name)
}

#[tauri::command]
fn scan_directory(path: String) -> Result<Vec<ImageFile>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err("Not a directory".into());
    }
    let mut files: Vec<ImageFile> = Vec::new();
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let p = entry.path();
        if is_image(&p) {
            files.push(ImageFile {
                path: p.to_string_lossy().to_string(),
                name: entry.file_name().to_string_lossy().to_string(),
            });
        }
    }
    Ok(files)
}

#[tauri::command]
fn get_image_info(path: String) -> Result<ImageInfo, String> {
    let p = Path::new(&path);
    let size = fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    if let Ok((width, height)) = image::image_dimensions(p) {
        Ok(ImageInfo { width, height, size })
    } else {
        Ok(ImageInfo { width: 0, height: 0, size })
    }
}

#[tauri::command]
fn search_images(path: String) -> Result<Vec<ImageFile>, String> {
    let mut files: Vec<ImageFile> = Vec::new();
    for entry in WalkDir::new(&path).max_depth(5).into_iter().filter_map(|e| e.ok()) {
        if is_image(entry.path()) {
            files.push(ImageFile {
                path: entry.path().to_string_lossy().to_string(),
                name: entry.file_name().to_string_lossy().to_string(),
            });
        }
    }
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(files)
}

#[tauri::command]
fn get_recent_paths(app: tauri::AppHandle) -> Result<RecentPaths, String> {
    let f = recent_file(&app);
    if f.exists() {
        let data = fs::read_to_string(&f).map_err(|e| e.to_string())?;
        serde_json::from_str(&data).map_err(|e| e.to_string())
    } else {
        Ok(RecentPaths { paths: vec![] })
    }
}

#[tauri::command]
fn save_recent_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let f = recent_file(&app);
    let mut recent: RecentPaths = if f.exists() {
        let data = fs::read_to_string(&f).unwrap_or_default();
        serde_json::from_str(&data).unwrap_or(RecentPaths { paths: vec![] })
    } else {
        RecentPaths { paths: vec![] }
    };
    recent.paths.retain(|p| p != &path);
    recent.paths.insert(0, path);
    if recent.paths.len() > 20 {
        recent.paths.truncate(20);
    }
    let data = serde_json::to_string_pretty(&recent).map_err(|e| e.to_string())?;
    fs::write(&f, data).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    open::that(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn add_folder_scope(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        app.asset_protocol_scope()
            .allow_directory(p.to_path_buf(), true)
            .map_err(|e| e.to_string())?;
    } else if let Some(parent) = p.parent() {
        app.asset_protocol_scope()
            .allow_directory(parent.to_path_buf(), true)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Generate thumbnails in batch — parallel across all CPU cores
#[tauri::command]
fn get_thumbnails(app: tauri::AppHandle, paths: Vec<String>) -> Result<Vec<String>, String> {
    let cache = thumb_dir(&app);

    // Pre-compute output paths so we can check cache hits without spawning threads
    let pairs: Vec<(String, std::path::PathBuf)> = paths
        .iter()
        .map(|p| (p.clone(), thumb_path(&cache, p)))
        .collect();

    // Collect indices that actually need work (cache miss)
    let needs_work: Vec<usize> = pairs
        .iter()
        .enumerate()
        .filter(|(_, (_, out))| !out.exists())
        .map(|(i, _)| i)
        .collect();

    // Parallelise only cache-miss items using scoped threads
    std::thread::scope(|s| {
        for &idx in &needs_work {
            let src = &pairs[idx].0;
            let out = &pairs[idx].1;
            s.spawn(move || {
                if let Ok(img) = image::open(src) {
                    let thumb = img.thumbnail(180, 180);
                    thumb.save(out).ok();
                }
            });
        }
    }); // all threads joined here

    // Build result vec (cache hit OR freshly generated)
    let results = pairs
        .iter()
        .map(|(src, out)| {
            if out.exists() {
                out.to_string_lossy().to_string()
            } else {
                src.clone() // fallback to original path
            }
        })
        .collect();

    Ok(results)
}

/// Clean old thumbnails
#[tauri::command]
fn clean_thumb_cache(app: tauri::AppHandle) -> Result<(), String> {
    let cache = thumb_dir(&app);
    if let Ok(entries) = fs::read_dir(&cache) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().map(|e| e == "jpg").unwrap_or(false) {
                fs::remove_file(&p).ok();
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn get_exif(path: String, state: tauri::State<'_, Mutex<ExifCache>>) -> Result<ExifData, String> {
    let p = Path::new(&path);
    let mtime = fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    {
        let cache = state.lock().unwrap();
        if let Some(data) = cache.get(&path, mtime) {
            return Ok(data.clone());
        }
    }

    let mut exif = ExifData::default();
    if let Ok(file) = std::fs::File::open(&path) {
        let mut reader = std::io::BufReader::new(file);
        if let Ok(exif_reader) = exif::Reader::new().read_from_container(&mut reader) {
            let fv = |tag: exif::Tag| -> Option<String> {
                exif_reader.get_field(tag, exif::In::PRIMARY)
                    .map(|f| f.display_value().to_string())
            };
            let fvi = |tag: exif::Tag| -> Option<i64> {
                if let Some(field) = exif_reader.get_field(tag, exif::In::PRIMARY) {
                    if let exif::Value::Rational(rationals) = &field.value {
                        return rationals.first().map(|r| r.to_f64() as i64);
                    }
                }
                None
            };
            let fvf = |tag: exif::Tag| -> Option<f64> {
                if let Some(field) = exif_reader.get_field(tag, exif::In::PRIMARY) {
                    if let exif::Value::Rational(rationals) = &field.value {
                        let d = rationals.first().map(|r| r.to_f64()).unwrap_or(0.0);
                        let m = rationals.get(1).map(|r| r.to_f64()).unwrap_or(0.0);
                        let s = rationals.get(2).map(|r| r.to_f64()).unwrap_or(0.0);
                        return Some(d + m / 60.0 + s / 3600.0);
                    }
                }
                None
            };

            let make = fv(exif::Tag::Make);
            let model = fv(exif::Tag::Model);
            exif.camera = match (make, model) {
                (Some(m), Some(mo)) => Some(format!("{} {}", m, mo)),
                (Some(m), None) => Some(m),
                (None, Some(mo)) => Some(mo),
                _ => None,
            };
            exif.software = fv(exif::Tag::Software);
            exif.date_time = fv(exif::Tag::DateTime);
            exif.aperture = fv(exif::Tag::FNumber);
            exif.shutter = fv(exif::Tag::ExposureTime);
            exif.iso = fvi(exif::Tag::PhotographicSensitivity);
            exif.focal_length = fv(exif::Tag::FocalLength);
            exif.flash = fv(exif::Tag::Flash);
            exif.orientation = fv(exif::Tag::Orientation);

            // GPS
            let gps_lat = fvf(exif::Tag::GPSLatitude);
            let gps_lat_ref = fv(exif::Tag::GPSLatitudeRef);
            let gps_lon = fvf(exif::Tag::GPSLongitude);
            let gps_lon_ref = fv(exif::Tag::GPSLongitudeRef);
            exif.gps_lat = gps_lat.map(|v| if gps_lat_ref.as_deref() == Some("S") { -v } else { v });
            exif.gps_lon = gps_lon.map(|v| if gps_lon_ref.as_deref() == Some("W") { -v } else { v });
        }
    }

    let data = exif.clone();
    {
        let mut cache = state.lock().unwrap();
        cache.insert(path, mtime, data);
    }
    Ok(exif)
}

#[tauri::command]
fn trash_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() { return Err("El archivo ya no existe".into()); }
    trash::delete(&path).map_err(|e| format!("No se pudo mover a la papelera: {}", e))?;
    if p.exists() {
        Err("El archivo no se pudo mover a la papelera".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
fn rename_file(path: String, new_name: String) -> Result<String, String> {
    let old = Path::new(&path);
    let parent = old.parent().ok_or("No parent directory")?;
    let new_path = parent.join(&new_name);
    std::fs::rename(old, &new_path).map_err(|e| e.to_string())?;
    Ok(new_path.to_string_lossy().to_string())
}

pub fn run() {
    // Pequeño delay para evitar condición de carrera al inicializar EGL
    // bajo compositores Wayland (ej. KDE Plasma) antes de crear el WebView.
    #[cfg(target_os = "linux")]
    std::thread::sleep(std::time::Duration::from_millis(400));

    tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .manage(Mutex::new(ExifCache::new()))
    .setup(|app| {
        if cfg!(debug_assertions) {
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
            )?;
        }
        // Add cache dir to asset scope so thumbnails load
        let cache = thumb_dir(app.handle());
        if cache.exists() {
            app.handle().asset_protocol_scope()
            .allow_directory(cache, true)
            .ok();
        }
        Ok(())
    })
    .invoke_handler(tauri::generate_handler![
        scan_directory,
        get_image_info,
        search_images,
        get_recent_paths,
        save_recent_path,
        open_folder,
        add_folder_scope,
        get_thumbnails,
        clean_thumb_cache,
        get_exif,
        trash_file,
        rename_file,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
