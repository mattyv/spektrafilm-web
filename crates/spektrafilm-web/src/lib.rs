use image::ImageEncoder;
use serde::{Deserialize, Serialize};
use spektrafilm_core::{
    neutral_filters::NeutralFilters,
    params::{Adjustments, Composition, RuntimeParams},
    pipeline::{Pipeline, PipelineAssets},
    profile::load_profile_reader,
    spectral_service::{SpectraLut, load_spectra_lut_reader},
};
use spektrafilm_gpu::cpu_backend::CpuBackend;
use spektrafilm_math::{
    image::ImageBuf,
    precision::{Scalar, from_f32, srgb_decode, srgb_encode, to_f32},
};
use std::borrow::Cow;
use std::io::{Cursor, Seek, Write};
use wasm_bindgen::prelude::*;

#[cfg(feature = "threads")]
pub use wasm_bindgen_rayon::init_thread_pool;

mod icc;

pub const DEFAULT_MEMORY_BUDGET_BYTES: u64 = 768 * 1024 * 1024;
pub const MAX_STORAGE_BINDING_BYTES: u64 = 128 * 1024 * 1024;
pub const MAX_WORKGROUP_INVOCATIONS: u32 = 256;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLimits {
    #[serde(default = "default_memory_budget")]
    pub memory_budget_bytes: u64,
    #[serde(default = "default_storage_binding")]
    pub max_storage_binding_bytes: u64,
}

impl Default for DeviceLimits {
    fn default() -> Self {
        Self {
            memory_budget_bytes: DEFAULT_MEMORY_BUDGET_BYTES,
            max_storage_binding_bytes: MAX_STORAGE_BINDING_BYTES,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInspection {
    pub width: u32,
    pub height: u32,
    pub megapixels: f64,
    pub estimated_working_bytes: u64,
    pub tile_rows: u32,
    pub requires_resize: bool,
    pub maximum_safe_megapixels: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CalibrationSummary {
    film: String,
    print: String,
    spectral_lut_size: usize,
    print_exposure_factor: f64,
}

struct MemoryAssets<'a> {
    neutral_filters: &'a [u8],
    spectral_lut: &'a [u8],
}

#[wasm_bindgen]
pub struct BrowserEngine {
    pipeline: Pipeline,
    gpu: Option<spektrafilm_gpu::wgpu_backend::WgpuBackend>,
    source: EngineSource,
    raw_development: RawDevelopment,
}

#[derive(Clone, Copy)]
struct RawDevelopment {
    camera_white_balance: bool,
    demosaic: RawDemosaic,
}

impl Default for RawDevelopment {
    fn default() -> Self {
        Self { camera_white_balance: true, demosaic: RawDemosaic::Ppg }
    }
}

#[derive(Clone, Copy, Default)]
enum RawDemosaic {
    #[default]
    Ppg,
    Superpixel,
}

fn raw_developer(options: RawDevelopment) -> rawler::imgop::develop::RawDevelop {
    use rawler::imgop::develop::{DemosaicMethod, ProcessingStep, RawDevelop};
    let mut developer = RawDevelop::default();
    developer.steps.retain(|step| {
        !matches!(step, ProcessingStep::SRgb)
            && (options.camera_white_balance || !matches!(step, ProcessingStep::WhiteBalance))
    });
    developer.demosaic_method = match options.demosaic {
        RawDemosaic::Ppg => DemosaicMethod::Ppg,
        RawDemosaic::Superpixel => DemosaicMethod::Superpixel,
    };
    developer
}

fn raw_preview_channel(linear: f32) -> f32 {
    to_f32(srgb_encode(from_f32(linear.clamp(0.0, 1.0))))
}

struct EngineSource {
    film: Vec<u8>,
    print: Vec<u8>,
    filters: Vec<u8>,
    lut: Vec<u8>,
}

impl PipelineAssets for MemoryAssets<'_> {
    fn neutral_filters(&self) -> NeutralFilters {
        NeutralFilters::from_json(self.neutral_filters)
    }

    fn spectra_lut(&self, method: &str) -> Result<SpectraLut, String> {
        load_spectra_lut_reader(Cursor::new(self.spectral_lut), method)
    }
}

#[derive(Debug, thiserror::Error)]
enum InspectError {
    #[error("unsupported or damaged image: {0}")]
    Decode(#[from] image::ImageError),
    #[error("unsupported or damaged RAW image: {0}")]
    Raw(String),
    #[error("invalid device limits: {0}")]
    Limits(String),
    #[error("failed to serialize browser response: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("invalid pixel buffer: expected {expected} bytes, received {actual}")]
    PixelBuffer { expected: usize, actual: usize },
    #[error("unsupported output format: {0}")]
    OutputFormat(String),
    #[error("could not preserve photo metadata: {0}")]
    Metadata(String),
    #[error("could not encode output: {0}")]
    Encode(String),
}

fn default_memory_budget() -> u64 {
    DEFAULT_MEMORY_BUDGET_BYTES
}

fn default_storage_binding() -> u64 {
    MAX_STORAGE_BINDING_BYTES
}

#[wasm_bindgen(start)]
// Native coverage cannot execute browser console glue; startup is exercised by Playwright.
#[cfg(not(coverage))]
pub fn start() {
    std::panic::set_hook(Box::new(|info| {
        web_sys::console::error_1(&format!("Spektrafilm panic: {info}").into());
        web_sys::console::trace_0();
    }));
}

fn estimated_working_bytes(width: u32, height: u32) -> u64 {
    // RAW mosaic + developed f32 + f64 reference image + reusable stage buffers.
    u64::from(width) * u64::from(height) * 80
}

fn clamp_browser_memory_budget(bytes: u64) -> u64 {
    bytes.min(2 * 1024_u64.pow(3))
}

fn png_chunk_end(offset: usize, length: usize, input_len: usize) -> Option<usize> {
    offset
        .checked_add(12)?
        .checked_add(length)
        .filter(|&end| end <= input_len)
}

fn inspect_dimensions(
    width: u32,
    height: u32,
    limits: DeviceLimits,
) -> Result<ImageInspection, InspectError> {
    if limits.memory_budget_bytes == 0 || limits.max_storage_binding_bytes < 12 {
        return Err(InspectError::Limits(
            "memory and storage-buffer limits must be positive".into(),
        ));
    }

    let row_bytes = u64::from(width) * 3 * 4;
    let tile_rows = if row_bytes == 0 {
        0
    } else {
        (limits.max_storage_binding_bytes / row_bytes).clamp(1, u64::from(height).max(1)) as u32
    };
    let memory_budget_bytes = clamp_browser_memory_budget(limits.memory_budget_bytes);
    let bytes = estimated_working_bytes(width, height);
    let maximum_safe_pixels = memory_budget_bytes / 80;

    Ok(ImageInspection {
        width,
        height,
        megapixels: f64::from(width) * f64::from(height) / 1_000_000.0,
        estimated_working_bytes: bytes,
        tile_rows,
        requires_resize: bytes > memory_budget_bytes
            || row_bytes > limits.max_storage_binding_bytes,
        maximum_safe_megapixels: maximum_safe_pixels as f64 / 1_000_000.0,
    })
}

fn inspect_image_inner(
    bytes: &[u8],
    limits: DeviceLimits,
) -> Result<ImageInspection, InspectError> {
    let source = rawler::rawsource::RawSource::new_from_slice(bytes);
    let (width, height) = match rawler::decode_dummy(&source) {
        Ok(raw) => (raw.width as u32, raw.height as u32),
        Err(_) => image::ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(image::ImageError::IoError)?
            .into_dimensions()?,
    };
    inspect_dimensions(width, height, limits)
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").into()
}

#[wasm_bindgen]
// Native coverage cannot create a browser WebGPU adapter; Playwright exercises this wrapper.
#[cfg(not(coverage))]
pub async fn initialize_webgpu() -> Result<String, JsValue> {
    spektrafilm_gpu::wgpu_backend::WgpuBackend::new_async()
        .await
        .map(|_| "ready".into())
        .ok_or_else(|| JsValue::from_str("no compatible WebGPU adapter"))
}

#[wasm_bindgen]
pub fn default_settings_json() -> Result<String, JsValue> {
    serde_json::to_string(&browser_default_params())
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

fn browser_default_params() -> RuntimeParams {
    browser_params(RuntimeParams::default())
}

fn browser_params(mut params: RuntimeParams) -> RuntimeParams {
    params.io.input_color_space = "sRGB".into();
    params.io.input_cctf_decoding = false;
    params
}

#[wasm_bindgen]
pub fn portable_limits_json() -> String {
    format!(
        "{{\"memoryBudgetBytes\":{DEFAULT_MEMORY_BUDGET_BYTES},\"maxStorageBindingBytes\":{MAX_STORAGE_BINDING_BYTES},\"maxWorkgroupInvocations\":{MAX_WORKGROUP_INVOCATIONS}}}"
    )
}

#[wasm_bindgen]
pub fn inspect_image(bytes: &[u8], limits_json: Option<String>) -> Result<String, JsValue> {
    let limits = limits_json
        .map(|json| serde_json::from_str(&json))
        .transpose()
        .map_err(|error| JsValue::from_str(&format!("invalid device limits: {error}")))?
        .unwrap_or_default();
    let inspection = inspect_image_inner(bytes, limits)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    serde_json::to_string(&inspection).map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
// RAW preview selection is browser-export glue covered with the repository DNG in Playwright.
#[cfg(not(coverage))]
pub fn raw_preview(
    bytes: &[u8],
    maximum_size: u32,
    develop_sensor_data: bool,
    camera_white_balance: bool,
    demosaic: &str,
) -> Result<Vec<u8>, JsValue> {
    use rawler::{decoders::RawDecodeParams, rawsource::RawSource};

    let source = RawSource::new_from_slice(bytes);
    let params = RawDecodeParams::default();
    let decoder = rawler::get_decoder(&source)
        .map_err(|error| JsValue::from_str(&format!("RAW preview failed: {error}")))?;
    let orientation = raw_orientation(&source, &params);
    let preview = if develop_sensor_data {
        None
    } else {
        let mut preview = decoder
            .full_image(&source, &params)
            .map_err(|error| JsValue::from_str(&format!("RAW preview failed: {error}")))?;
        if preview.is_none() {
            preview = decoder
                .preview_image(&source, &params)
                .map_err(|error| JsValue::from_str(&format!("RAW preview failed: {error}")))?;
        }
        if preview.is_none() {
            preview = decoder
                .thumbnail_image(&source, &params)
                .map_err(|error| JsValue::from_str(&format!("RAW preview failed: {error}")))?;
        }
        preview
    };
    let mut preview = match preview {
        Some(image) => image,
        None => {
            let raw = rawler::decode(&source, &params)
                .map_err(|error| JsValue::from_str(&format!("RAW preview failed: {error}")))?;
            raw_developer(RawDevelopment {
                camera_white_balance,
                demosaic: if demosaic == "superpixel" { RawDemosaic::Superpixel } else { RawDemosaic::Ppg },
            })
                .develop_intermediate(&raw)
                .map_err(|error| JsValue::from_str(&format!("RAW preview failed: {error}")))?
                .to_dynamic_image()
                .ok_or_else(|| JsValue::from_str("RAW preview has invalid dimensions"))?
        }
    };
    if let Some(orientation) = orientation {
        preview.apply_orientation(orientation);
    }
    let preview = preview.thumbnail(maximum_size.max(1), maximum_size.max(1));
    let preview = if develop_sensor_data {
        let mut preview = preview.to_rgb32f();
        preview.as_mut().iter_mut().for_each(|value| *value = raw_preview_channel(*value));
        image::DynamicImage::ImageRgb32F(preview).to_rgb8()
    } else {
        preview.to_rgb8()
    };
    let mut output = Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 88)
        .write_image(
            preview.as_raw(),
            preview.width(),
            preview.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|error| JsValue::from_str(&format!("RAW preview failed: {error}")))?;
    Ok(output.into_inner())
}

fn encode_rgb8_inner(
    width: u32,
    height: u32,
    pixels: &[u8],
    format: &str,
    quality: u8,
) -> Result<Vec<u8>, InspectError> {
    let expected = width as usize * height as usize * 3;
    if pixels.len() != expected {
        return Err(InspectError::PixelBuffer {
            expected,
            actual: pixels.len(),
        });
    }

    let mut output = Cursor::new(Vec::new());
    match format.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => {
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, quality.clamp(1, 100))
                .write_image(pixels, width, height, image::ExtendedColorType::Rgb8)?
        }
        "png" => image::codecs::png::PngEncoder::new(&mut output).write_image(
            pixels,
            width,
            height,
            image::ExtendedColorType::Rgb8,
        )?,
        "tif" | "tiff" => image::codecs::tiff::TiffEncoder::new(&mut output).write_image(
            pixels,
            width,
            height,
            image::ExtendedColorType::Rgb8,
        )?,
        other => return Err(InspectError::OutputFormat(other.into())),
    }
    Ok(output.into_inner())
}

#[wasm_bindgen]
pub fn encode_rgb8(
    width: u32,
    height: u32,
    pixels: &[u8],
    format: &str,
    quality: u8,
) -> Result<Vec<u8>, JsValue> {
    encode_rgb8_inner(width, height, pixels, format, quality)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
pub fn calibrate_pipeline(
    film_json: &[u8],
    print_json: &[u8],
    neutral_filters_json: &[u8],
    spectral_lut_npy: &[u8],
    settings_json: Option<String>,
) -> Result<String, JsValue> {
    let film = load_profile_reader(Cursor::new(film_json), "film profile")
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let print = load_profile_reader(Cursor::new(print_json), "print profile")
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let params = browser_params(settings_json
        .map(|json| serde_json::from_str(&json))
        .transpose()
        .map_err(|error| JsValue::from_str(&format!("invalid settings: {error}")))?
        .unwrap_or_else(browser_default_params));
    let assets = MemoryAssets {
        neutral_filters: neutral_filters_json,
        spectral_lut: spectral_lut_npy,
    };
    let pipeline = Pipeline::new_with_assets(film, print, params, &assets)
        .map_err(|error| JsValue::from_str(&error))?;
    let summary = CalibrationSummary {
        film: pipeline.film.info.stock.clone().unwrap_or_default(),
        print: pipeline.print.info.stock.clone().unwrap_or_default(),
        spectral_lut_size: pipeline.tc_lut().map_or(0, |lut| lut.size),
        print_exposure_factor: pipeline.print_exposure_factor(),
    };
    serde_json::to_string(&summary).map_err(|error| JsValue::from_str(&error.to_string()))
}

fn build_pipeline(
    film_json: &[u8],
    print_json: &[u8],
    neutral_filters_json: &[u8],
    spectral_lut_npy: &[u8],
    settings_json: Option<String>,
) -> Result<Pipeline, String> {
    let film = load_profile_reader(Cursor::new(film_json), "film profile")
        .map_err(|error| error.to_string())?;
    let print = load_profile_reader(Cursor::new(print_json), "print profile")
        .map_err(|error| error.to_string())?;
    let params = browser_params(settings_json
        .map(|json| serde_json::from_str(&json))
        .transpose()
        .map_err(|error| format!("invalid settings: {error}"))?
        .unwrap_or_else(browser_default_params));
    Pipeline::new_with_assets(
        film,
        print,
        params,
        &MemoryAssets {
            neutral_filters: neutral_filters_json,
            spectral_lut: spectral_lut_npy,
        },
    )
}

fn decode_standard_image(bytes: &[u8], scale: f32, raw_development: RawDevelopment) -> Result<ImageBuf, InspectError> {
    let source = rawler::rawsource::RawSource::new_from_slice(bytes);
    if rawler::get_decoder(&source).is_ok() {
        return decode_raw_image(bytes, scale, raw_development);
    }
    let rgb = match image::load_from_memory(bytes) {
        Ok(image) => image.to_rgb32f(),
        Err(_) => return decode_raw_image(bytes, scale, raw_development),
    };
    let rgb = resize_rgb_f32(rgb, scale);
    let (width, height) = rgb.dimensions();
    let data = rgb
        .into_raw()
        .into_iter()
        .map(|value| srgb_decode(from_f32(value)))
        .collect();
    Ok(ImageBuf::from_data(width, height, data))
}

fn intermediate_rgb(
    developed: rawler::imgop::develop::Intermediate,
) -> (rawler::imgop::Dim2, Vec<f32>) {
    use rawler::imgop::develop::Intermediate;
    let dimensions = developed.dim();
    let pixels = match developed {
        Intermediate::Monochrome(pixels) => pixels
            .data
            .into_iter()
            .flat_map(|value| [value.max(0.0); 3])
            .collect(),
        Intermediate::ThreeColor(mut pixels) => {
            pixels.data.iter_mut().flatten().for_each(|value| *value = value.max(0.0));
            pixels.data.into_flattened()
        }
        Intermediate::FourColor(pixels) => pixels
            .data
            .into_iter()
            .flat_map(|pixel| [pixel[0].max(0.0), pixel[1].max(0.0), pixel[2].max(0.0)])
            .collect(),
    };
    (dimensions, pixels)
}

fn decode_raw_image(bytes: &[u8], scale: f32, raw_development: RawDevelopment) -> Result<ImageBuf, InspectError> {
    use rawler::{
        decoders::RawDecodeParams,
        rawsource::RawSource,
    };

    let source = RawSource::new_from_slice(bytes);
    let params = RawDecodeParams::default();
    let orientation = raw_orientation(&source, &params);
    let raw =
        rawler::decode(&source, &params).map_err(|error| InspectError::Raw(error.to_string()))?;
    let (raw_development, scale) = bounded_raw_decode(raw_development, scale, raw.width as u64 * raw.height as u64);
    let developed = raw_developer(raw_development)
        .develop_intermediate(&raw)
        .map_err(|error| InspectError::Raw(error.to_string()))?;
    drop(raw);
    let (dimensions, pixels) = intermediate_rgb(developed);
    let rgb = image::ImageBuffer::from_raw(dimensions.w as u32, dimensions.h as u32, pixels)
        .ok_or(InspectError::PixelBuffer {
            expected: dimensions.w * dimensions.h * 3,
            actual: 0,
        })?;
    let mut rgb = image::DynamicImage::ImageRgb32F(rgb);
    if let Some(orientation) = orientation {
        rgb.apply_orientation(orientation);
    }
    let rgb = rgb.into_rgb32f();
    let rgb = resize_rgb_f32(rgb, scale);
    let (width, height) = rgb.dimensions();
    Ok(ImageBuf::from_data(
        width,
        height,
        rgb.into_raw().into_iter().map(from_f32).collect(),
    ))
}

fn bounded_raw_decode(mut development: RawDevelopment, scale: f32, pixels: u64) -> (RawDevelopment, f32) {
    if pixels > 24_000_000 && scale <= 0.5 && matches!(development.demosaic, RawDemosaic::Ppg) {
        development.demosaic = RawDemosaic::Superpixel;
        return (development, (scale * 2.0).min(1.0));
    }
    (development, scale)
}

fn raw_orientation(
    source: &rawler::rawsource::RawSource,
    params: &rawler::decoders::RawDecodeParams,
) -> Option<image::metadata::Orientation> {
    rawler::get_decoder(source)
        .ok()?
        .raw_metadata(source, params)
        .ok()?
        .exif
        .orientation
        .and_then(|value| image::metadata::Orientation::from_exif(value as u8))
}

fn raw_orientation_from_bytes(bytes: &[u8]) -> Option<image::metadata::Orientation> {
    let source = rawler::rawsource::RawSource::new_from_slice(bytes);
    raw_orientation(&source, &rawler::decoders::RawDecodeParams::default())
}

fn resize_rgb_f32(image: image::Rgb32FImage, scale: f32) -> image::Rgb32FImage {
    if !(scale > 0.0 && (scale - 1.0).abs() > 1e-6) {
        return image;
    }
    let width = ((image.width() as f32 * scale).round() as u32).max(1);
    let height = ((image.height() as f32 * scale).round() as u32).max(1);
    image::imageops::resize(
        &image,
        width,
        height,
        image::imageops::FilterType::CatmullRom,
    )
}

fn resize_image_buf(image: ImageBuf, scale: f32) -> ImageBuf {
    if !(scale > 0.0 && (scale - 1.0).abs() > 1e-6) {
        return image;
    }
    let rgb = image::ImageBuffer::from_raw(
        image.width,
        image.height,
        image.data.into_iter().map(to_f32).collect(),
    )
    .expect("ImageBuf dimensions match its data");
    let resized = resize_rgb_f32(rgb, scale);
    let (width, height) = resized.dimensions();
    ImageBuf::from_data(
        width,
        height,
        resized.into_raw().into_iter().map(from_f32).collect(),
    )
}

#[derive(Clone, Copy)]
struct Strip {
    core_start: u32,
    core_end: u32,
    input_start: u32,
    input_end: u32,
}

fn seed_strip(pipeline: &mut Pipeline, strip: Strip, base_seeds: [u64; 3]) {
    let offset = u64::from(strip.input_start).wrapping_mul(0x9E37_79B9);
    pipeline.params.film_render.grain.seed = base_seeds[0].wrapping_add(offset);
    pipeline.params.film_render.glare.seed = base_seeds[1].wrapping_add(offset);
    pipeline.params.print_render.glare.seed = base_seeds[2].wrapping_add(offset);
}

fn strips(width: u32, height: u32, maximum_pixels: u64, halo: u32) -> (bool, Vec<Strip>) {
    let horizontal = width >= height;
    let long = if horizontal { width } else { height };
    let short = if horizontal { height } else { width };
    let span = (maximum_pixels / u64::from(long)).max(1) as u32;
    let halo = halo.min(span.saturating_sub(1) / 2);
    let core = span.saturating_sub(halo * 2).max(1);
    let mut result = Vec::new();
    let mut start = 0;
    while start < short {
        let end = (start + core).min(short);
        result.push(Strip {
            core_start: start,
            core_end: end,
            input_start: start.saturating_sub(halo),
            input_end: (end + halo).min(short),
        });
        start = end;
    }
    (horizontal, result)
}

fn extract_strip(image: &ImageBuf, horizontal: bool, strip: Strip) -> ImageBuf {
    if horizontal {
        let row = image.width as usize * 3;
        let start = strip.input_start as usize * row;
        let end = strip.input_end as usize * row;
        ImageBuf::from_data(
            image.width,
            strip.input_end - strip.input_start,
            image.data[start..end].to_vec(),
        )
    } else {
        let width = strip.input_end - strip.input_start;
        let mut data = Vec::with_capacity(width as usize * image.height as usize * 3);
        for row in image.data.chunks_exact(image.width as usize * 3) {
            data.extend_from_slice(
                &row[strip.input_start as usize * 3..strip.input_end as usize * 3],
            );
        }
        ImageBuf::from_data(width, image.height, data)
    }
}

fn insert_strip(
    output: &mut [Scalar],
    width: u32,
    height: u32,
    horizontal: bool,
    strip: Strip,
    image: &ImageBuf,
) {
    let offset = strip.core_start - strip.input_start;
    if horizontal {
        let row = width as usize * 3;
        for y in strip.core_start..strip.core_end {
            let source_y = (y - strip.core_start + offset) as usize;
            output[y as usize * row..(y as usize + 1) * row]
                .copy_from_slice(&image.data[source_y * row..(source_y + 1) * row]);
        }
    } else {
        let source_row = image.width as usize * 3;
        let target_row = width as usize * 3;
        let count = (strip.core_end - strip.core_start) as usize * 3;
        for y in 0..height as usize {
            let source = y * source_row + offset as usize * 3;
            let target = y * target_row + strip.core_start as usize * 3;
            output[target..target + count].copy_from_slice(&image.data[source..source + count]);
        }
    }
}

struct RawAscii(Vec<u8>);

impl tiff::encoder::TiffValue for RawAscii {
    const BYTE_LEN: u8 = 1;
    const FIELD_TYPE: tiff::tags::Type = tiff::tags::Type::ASCII;

    fn count(&self) -> usize {
        self.0.len()
    }

    fn data(&self) -> Cow<'_, [u8]> {
        Cow::Borrowed(&self.0)
    }
}

struct RawUndefined(Vec<u8>);

impl tiff::encoder::TiffValue for RawUndefined {
    const BYTE_LEN: u8 = 1;
    const FIELD_TYPE: tiff::tags::Type = tiff::tags::Type::UNDEFINED;

    fn count(&self) -> usize {
        self.0.len()
    }

    fn data(&self) -> Cow<'_, [u8]> {
        Cow::Borrowed(&self.0)
    }
}

fn exif_words<const N: usize>(bytes: &[u8], endian: &little_exif::endian::Endian) -> Vec<[u8; N]> {
    bytes
        .chunks_exact(N)
        .map(|chunk| {
            let mut value = [0; N];
            value.copy_from_slice(chunk);
            if matches!(endian, little_exif::endian::Endian::Big) != cfg!(target_endian = "big") {
                value.reverse();
            }
            value
        })
        .collect()
}

fn write_exif_tags<W: Write + Seek, K: tiff::encoder::TiffKind>(
    encoder: &mut tiff::encoder::DirectoryEncoder<'_, W, K>,
    ifd: &little_exif::ifd::ImageFileDirectory,
    endian: &little_exif::endian::Endian,
    skip_structural: bool,
) -> Result<(), InspectError> {
    use little_exif::exif_tag_format::ExifTagFormat;
    use tiff::tags::Tag;

    const STRUCTURAL: &[u16] = &[
        0x0100, 0x0101, 0x0102, 0x0103, 0x0106, 0x0111, 0x0115, 0x0116, 0x0117, 0x011a, 0x011b,
        0x0128, 0x014a, 0x0201, 0x0202, 0x8769, 0x8825, 0xa005, 0x83bb, 0x02bc, 0x8773,
    ];

    for tag in ifd.get_tags() {
        let id = tag.as_u16();
        if !tag.is_writable() || (skip_structural && STRUCTURAL.contains(&id)) {
            continue;
        }
        let tiff_tag = Tag::Unknown(id);
        let bytes = tag.value_as_u8_vec(endian);
        if bytes.is_empty() {
            continue;
        }
        let result = match tag.format() {
            ExifTagFormat::INT8U => encoder.write_tag(tiff_tag, bytes.as_slice()),
            ExifTagFormat::STRING => {
                let mut bytes = bytes;
                bytes.resize(bytes.len() + usize::from(bytes.last() != Some(&0)), 0);
                encoder.write_tag(tiff_tag, RawAscii(bytes))
            }
            ExifTagFormat::INT16U => {
                let values: Vec<u16> = exif_words::<2>(&bytes, endian)
                    .into_iter()
                    .map(u16::from_ne_bytes)
                    .collect();
                encoder.write_tag(tiff_tag, values.as_slice())
            }
            ExifTagFormat::INT32U => {
                let values: Vec<u32> = exif_words::<4>(&bytes, endian)
                    .into_iter()
                    .map(u32::from_ne_bytes)
                    .collect();
                encoder.write_tag(tiff_tag, values.as_slice())
            }
            ExifTagFormat::RATIONAL64U => {
                let words: Vec<u32> = exif_words::<4>(&bytes, endian)
                    .into_iter()
                    .map(u32::from_ne_bytes)
                    .collect();
                let values: Vec<tiff::encoder::Rational> = words
                    .chunks_exact(2)
                    .map(|value| tiff::encoder::Rational {
                        n: value[0],
                        d: value[1],
                    })
                    .collect();
                encoder.write_tag(tiff_tag, values.as_slice())
            }
            ExifTagFormat::INT8S => {
                let values: Vec<i8> = bytes.into_iter().map(|value| value as i8).collect();
                encoder.write_tag(tiff_tag, values.as_slice())
            }
            ExifTagFormat::UNDEF => encoder.write_tag(tiff_tag, RawUndefined(bytes)),
            ExifTagFormat::INT16S => {
                let values: Vec<i16> = exif_words::<2>(&bytes, endian)
                    .into_iter()
                    .map(i16::from_ne_bytes)
                    .collect();
                encoder.write_tag(tiff_tag, values.as_slice())
            }
            ExifTagFormat::INT32S => {
                let values: Vec<i32> = exif_words::<4>(&bytes, endian)
                    .into_iter()
                    .map(i32::from_ne_bytes)
                    .collect();
                encoder.write_tag(tiff_tag, values.as_slice())
            }
            ExifTagFormat::RATIONAL64S => {
                let words: Vec<i32> = exif_words::<4>(&bytes, endian)
                    .into_iter()
                    .map(i32::from_ne_bytes)
                    .collect();
                let values: Vec<tiff::encoder::SRational> = words
                    .chunks_exact(2)
                    .map(|value| tiff::encoder::SRational {
                        n: value[0],
                        d: value[1],
                    })
                    .collect();
                encoder.write_tag(tiff_tag, values.as_slice())
            }
            ExifTagFormat::FLOAT => {
                let values: Vec<f32> = exif_words::<4>(&bytes, endian)
                    .into_iter()
                    .map(f32::from_ne_bytes)
                    .collect();
                encoder.write_tag(tiff_tag, values.as_slice())
            }
            ExifTagFormat::DOUBLE => {
                let values: Vec<f64> = exif_words::<8>(&bytes, endian)
                    .into_iter()
                    .map(f64::from_ne_bytes)
                    .collect();
                encoder.write_tag(tiff_tag, values.as_slice())
            }
        };
        result.map_err(|error| InspectError::Encode(error.to_string()))?;
    }
    Ok(())
}

fn encode_image_buf(
    image: &ImageBuf,
    format: &str,
    quality: u8,
    icc_profile: &[u8],
    metadata: &AncillaryMetadata,
) -> Result<Vec<u8>, InspectError> {
    let mut output = Cursor::new(Vec::new());
    match format.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => {
            let pixels: Vec<u8> = image
                .data
                .iter()
                .map(|&value| ((to_f32(value).clamp(0.0, 1.0) * 255.0).round_ties_even()) as u8)
                .collect();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, quality.clamp(1, 100))
                .write_image(
                    &pixels,
                    image.width,
                    image.height,
                    image::ExtendedColorType::Rgb8,
                )?;
        }
        "png" => {
            let pixels: Vec<u8> = image
                .data
                .iter()
                .map(|&value| ((to_f32(value).clamp(0.0, 1.0) * 255.0).round_ties_even()) as u8)
                .collect();
            image::codecs::png::PngEncoder::new(&mut output).write_image(
                &pixels,
                image.width,
                image.height,
                image::ExtendedColorType::Rgb8,
            )?;
        }
        "tif" | "tiff" => {
            let pixels: Vec<u16> = image
                .data
                .iter()
                .map(|&value| (to_f32(value).clamp(0.0, 1.0) * 65535.0).round_ties_even() as u16)
                .collect();
            let mut encoder = tiff::encoder::TiffEncoder::new(&mut output)
                .map_err(|error| InspectError::Encode(error.to_string()))?;
            let (gps, exif) = if let Some(metadata) = &metadata.exif {
                use little_exif::ifd::ExifTagGroup;
                let endian = metadata.get_endian();
                let interop = if let Some(ifd) = metadata.get_ifd(ExifTagGroup::INTEROP, 0) {
                    let mut directory = encoder
                        .extra_directory()
                        .map_err(|error| InspectError::Encode(error.to_string()))?;
                    write_exif_tags(&mut directory, ifd, &endian, false)?;
                    Some(
                        directory
                            .finish_with_offsets()
                            .map_err(|error| InspectError::Encode(error.to_string()))?
                            .offset,
                    )
                } else {
                    None
                };
                let gps = if let Some(ifd) = metadata.get_ifd(ExifTagGroup::GPS, 0) {
                    let mut directory = encoder
                        .extra_directory()
                        .map_err(|error| InspectError::Encode(error.to_string()))?;
                    write_exif_tags(&mut directory, ifd, &endian, false)?;
                    Some(
                        directory
                            .finish_with_offsets()
                            .map_err(|error| InspectError::Encode(error.to_string()))?
                            .offset,
                    )
                } else {
                    None
                };
                let exif = if let Some(ifd) = metadata.get_ifd(ExifTagGroup::EXIF, 0) {
                    let mut directory = encoder
                        .extra_directory()
                        .map_err(|error| InspectError::Encode(error.to_string()))?;
                    write_exif_tags(&mut directory, ifd, &endian, false)?;
                    if let Some(offset) = interop {
                        directory
                            .write_tag(tiff::tags::Tag::Unknown(0xa005), offset)
                            .map_err(|error| InspectError::Encode(error.to_string()))?;
                    }
                    Some(
                        directory
                            .finish_with_offsets()
                            .map_err(|error| InspectError::Encode(error.to_string()))?
                            .offset,
                    )
                } else {
                    None
                };
                (gps, exif)
            } else {
                (None, None)
            };
            let mut encoded = encoder
                .new_image::<tiff::encoder::colortype::RGB16>(image.width, image.height)
                .map_err(|error| InspectError::Encode(error.to_string()))?;
            if let Some(metadata) = &metadata.exif {
                if let Some(ifd) = metadata.get_ifd(little_exif::ifd::ExifTagGroup::GENERIC, 0) {
                    write_exif_tags(encoded.encoder(), ifd, &metadata.get_endian(), true)?;
                }
            }
            if let Some(offset) = exif {
                encoded
                    .encoder()
                    .write_tag(tiff::tags::Tag::ExifDirectory, offset)
                    .map_err(|error| InspectError::Encode(error.to_string()))?;
            }
            if let Some(offset) = gps {
                encoded
                    .encoder()
                    .write_tag(tiff::tags::Tag::GpsDirectory, offset)
                    .map_err(|error| InspectError::Encode(error.to_string()))?;
            }
            encoded
                .encoder()
                .write_tag(tiff::tags::Tag::Unknown(34675), icc_profile)
                .map_err(|error| InspectError::Encode(error.to_string()))?;
            if let Some(xmp) = &metadata.xmp {
                encoded
                    .encoder()
                    .write_tag(tiff::tags::Tag::Unknown(700), xmp.as_slice())
                    .map_err(|error| InspectError::Encode(error.to_string()))?;
            }
            if let Some(iptc) = &metadata.iptc {
                encoded
                    .encoder()
                    .write_tag(tiff::tags::Tag::Unknown(33723), iptc.as_slice())
                    .map_err(|error| InspectError::Encode(error.to_string()))?;
            }
            encoded
                .write_data(&pixels)
                .map_err(|error| InspectError::Encode(error.to_string()))?;
        }
        other => return Err(InspectError::OutputFormat(other.into())),
    }
    Ok(output.into_inner())
}

fn embed_icc(mut output: Vec<u8>, format: &str, profile: &[u8]) -> Result<Vec<u8>, InspectError> {
    match format.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => {
            if output.get(..2) != Some(&[0xff, 0xd8]) {
                return Err(InspectError::Encode("invalid JPEG output".into()));
            }
            let length = u16::try_from(profile.len() + 16)
                .map_err(|_| InspectError::Encode("ICC profile is too large for JPEG".into()))?;
            let mut segment = Vec::with_capacity(profile.len() + 18);
            segment.extend_from_slice(&[0xff, 0xe2]);
            segment.extend_from_slice(&length.to_be_bytes());
            segment.extend_from_slice(b"ICC_PROFILE\0\x01\x01");
            segment.extend_from_slice(profile);
            output.splice(2..2, segment);
        }
        "png" => {
            if output.get(..8) != Some(&[137, 80, 78, 71, 13, 10, 26, 10]) {
                return Err(InspectError::Encode("invalid PNG output".into()));
            }
            let compressed = miniz_oxide::deflate::compress_to_vec_zlib(profile, 6);
            let mut data = b"Spektra\0\0".to_vec();
            data.extend_from_slice(&compressed);
            let mut chunk = Vec::with_capacity(data.len() + 12);
            chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
            chunk.extend_from_slice(b"iCCP");
            chunk.extend_from_slice(&data);
            let mut crc = crc32fast::Hasher::new();
            crc.update(b"iCCP");
            crc.update(&data);
            chunk.extend_from_slice(&crc.finalize().to_be_bytes());
            let ihdr_end =
                8 + 4 + 4 + u32::from_be_bytes(output[8..12].try_into().unwrap()) as usize + 4;
            output.splice(ihdr_end..ihdr_end, chunk);
        }
        _ => {}
    }
    Ok(output)
}

fn encode_output_channel(linear: f32, color_space: &str, encoded: bool) -> f32 {
    let linear = linear.clamp(0.0, 1.0);
    if !encoded || color_space == "ACES2065-1" {
        linear
    } else if color_space == "ProPhoto RGB" {
        if linear < 1.0 / 512.0 {
            linear * 16.0
        } else {
            linear.powf(1.0 / 1.8)
        }
    } else if matches!(color_space, "Rec. 2020" | "Rec2020" | "ITU-R BT.2020") {
        if linear < 0.018_053_97 {
            linear * 4.5
        } else {
            1.099_296_8 * linear.powf(0.45) - 0.099_296_83
        }
    } else {
        to_f32(srgb_encode(from_f32(linear)))
    }
}

fn apply_adjustments(image: &mut ImageBuf, controls: &Adjustments) {
    if controls.temperature == 0.0 && controls.tint == 0.0 && controls.contrast == 0.0
        && controls.highlights == 0.0 && controls.shadows == 0.0 && controls.whites == 0.0
        && controls.blacks == 0.0 && controls.saturation == 0.0 && controls.vibrance == 0.0
        && controls.clarity == 0.0 && controls.dehaze == 0.0 { return; }
    let luminance = |rgb: &[Scalar]| 0.2126 * to_f32(rgb[0]) + 0.7152 * to_f32(rgb[1]) + 0.0722 * to_f32(rgb[2]);
    let smooth = |edge0: f32, edge1: f32, value: f32| {
        let value = ((value - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
        value * value * (3.0 - 2.0 * value)
    };
    let clarity = controls.clarity.clamp(-100.0, 100.0) / 100.0;
    let source = (clarity != 0.0).then(|| image.data.clone());
    for y in 0..image.height as usize {
        for x in 0..image.width as usize {
            let offset = (y * image.width as usize + x) * 3;
            let input = source.as_ref().unwrap_or(&image.data);
            let mut rgb = [to_f32(input[offset]), to_f32(input[offset + 1]), to_f32(input[offset + 2])];
            let temperature = controls.temperature.clamp(-100.0, 100.0) / 500.0;
            let tint = controls.tint.clamp(-100.0, 100.0) / 500.0;
            rgb[0] *= 1.0 + temperature;
            rgb[2] *= 1.0 - temperature;
            rgb[1] *= 1.0 + tint;
            rgb[0] *= 1.0 - tint * 0.5;
            rgb[2] *= 1.0 - tint * 0.5;
            let mut light = luminance(&[from_f32(rgb[0]), from_f32(rgb[1]), from_f32(rgb[2])]);
            let original_light = light.max(1e-6);
            light = (light - 0.18) * (1.0 + controls.contrast.clamp(-100.0, 100.0) / 100.0) + 0.18;
            let tone = smooth(0.0, 1.0, original_light);
            let shadow_weight = smooth(0.0, 0.08, original_light)
                * (1.0 - smooth(0.15, 0.65, original_light));
            light *= 2.0_f32.powf(
                controls.shadows.clamp(-100.0, 100.0) / 100.0 * 1.6 * shadow_weight,
            );
            let highlight_weight = smooth(0.2, 0.8, original_light);
            light *= 2.0_f32.powf(
                controls.highlights.clamp(-100.0, 100.0) / 100.0 * 1.5 * highlight_weight,
            );
            let whites = controls.whites.clamp(-100.0, 100.0) / 200.0;
            let white_weight = tone * tone;
            light += if whites >= 0.0 {
                whites * white_weight * (1.0 - light)
            } else {
                whites * white_weight * light
            };
            let black_weight = 1.0 - smooth(0.05, 0.45, original_light);
            light *= 2.0_f32.powf(
                controls.blacks.clamp(-100.0, 100.0) / 100.0 * black_weight,
            );
            let dehaze = controls.dehaze.clamp(-100.0, 100.0) / 100.0;
            light = (light - 0.08) * (1.0 + dehaze * 0.6) + 0.08;
            let scale = light.max(0.0) / original_light;
            rgb.iter_mut().for_each(|channel| *channel *= scale);
            let light = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
            let max = rgb.iter().copied().fold(f32::NEG_INFINITY, f32::max);
            let min = rgb.iter().copied().fold(f32::INFINITY, f32::min);
            let chroma = if max > 0.0 { (max - min) / max } else { 0.0 };
            let saturation = 1.0 + controls.saturation.clamp(-100.0, 100.0) / 100.0
                + controls.vibrance.clamp(-100.0, 100.0) / 100.0 * (1.0 - chroma);
            rgb.iter_mut().for_each(|channel| *channel = light + (*channel - light) * saturation);
            if clarity != 0.0 {
                let source = source.as_ref().unwrap();
                let mut blurred = 0.0;
                let mut count = 0.0;
                for sample_y in y.saturating_sub(1)..=(y + 1).min(image.height as usize - 1) {
                    for sample_x in x.saturating_sub(1)..=(x + 1).min(image.width as usize - 1) {
                        let sample = (sample_y * image.width as usize + sample_x) * 3;
                        blurred += luminance(&source[sample..sample + 3]);
                        count += 1.0;
                    }
                }
                let detail = (original_light - blurred / count) * clarity * 1.5;
                rgb.iter_mut().for_each(|channel| *channel += detail);
            }
            for channel in 0..3 { image.data[offset + channel] = from_f32(rgb[channel].clamp(0.0, 16.0)); }
        }
    }
}

fn apply_negative_film_adjustments(image: &mut ImageBuf, controls: &Adjustments) {
    let mut controls = controls.clone();
    controls.shadows = -controls.shadows;
    controls.highlights = -controls.highlights;
    controls.whites = -controls.whites;
    apply_adjustments(image, &controls);
}

fn apply_composition(image: ImageBuf, composition: &Composition) -> ImageBuf {
    let angle = composition.straighten_degrees.clamp(-45.0, 45.0);
    let scale = composition.crop_scale.clamp(10.0, 100.0) / 100.0;
    let border = composition.border.clamp(0.0, 40.0) / 100.0;
    if angle == 0.0 && composition.aspect == "original" && scale == 1.0
        && composition.crop_x == 0.0 && composition.crop_y == 0.0 && border == 0.0
        && composition.vignette_amount == 0.0 { return image; }
    if border > 0.0 {
        let mut content_settings = composition.clone();
        content_settings.aspect = "original".into();
        content_settings.border = 0.0;
        let content = apply_composition(image, &content_settings);
        let content_aspect = content.width as f32 / content.height as f32;
        let canvas_aspect = match composition.aspect.as_str() {
            "1:1" => 1.0, "4:5" => 0.8, "5:4" => 1.25, "3:2" => 1.5,
            "2:3" => 2.0 / 3.0, "16:9" => 16.0 / 9.0, _ => content_aspect,
        };
        let inner_scale = 1.0 - border;
        let (width, height) = if content_aspect >= canvas_aspect {
            let width = (content.width as f32 / inner_scale).ceil() as u32;
            (width, (width as f32 / canvas_aspect).ceil() as u32)
        } else {
            let height = (content.height as f32 / inner_scale).ceil() as u32;
            ((height as f32 * canvas_aspect).ceil() as u32, height)
        };
        let mut output = vec![from_f32(1.0); width as usize * height as usize * 3];
        let (left, top) = ((width - content.width) / 2, (height - content.height) / 2);
        for y in 0..content.height {
            let source = y as usize * content.width as usize * 3;
            let target = ((y + top) * width + left) as usize * 3;
            output[target..target + content.width as usize * 3]
                .copy_from_slice(&content.data[source..source + content.width as usize * 3]);
        }
        return ImageBuf::from_data(width, height, output);
    }
    let input_aspect = image.width as f32 / image.height as f32;
    let aspect = match composition.aspect.as_str() {
        "1:1" => 1.0, "4:5" => 0.8, "5:4" => 1.25, "3:2" => 1.5,
        "2:3" => 2.0 / 3.0, "16:9" => 16.0 / 9.0, _ => input_aspect,
    };
    let radians = angle.to_radians();
    let (sin, cos) = (radians.sin().abs(), radians.cos().abs());
    let crop_height = (image.width as f32 / (cos * aspect + sin))
        .min(image.height as f32 / (sin * aspect + cos)) * scale;
    let crop_width = crop_height * aspect;
    let content_width = crop_width.round().max(1.0) as u32;
    let content_height = crop_height.round().max(1.0) as u32;
    let extent_x = (image.width as f32 - (cos * crop_width + sin * crop_height)).max(0.0) * 0.5;
    let extent_y = (image.height as f32 - (sin * crop_width + cos * crop_height)).max(0.0) * 0.5;
    let center_x = (image.width as f32 - 1.0) * 0.5 + extent_x * composition.crop_x.clamp(-100.0, 100.0) / 100.0;
    let center_y = (image.height as f32 - 1.0) * 0.5 + extent_y * composition.crop_y.clamp(-100.0, 100.0) / 100.0;
    let inner_scale = 1.0 - border;
    let width = (content_width as f32 / inner_scale).round() as u32;
    let height = (content_height as f32 / inner_scale).round() as u32;
    let mut output = vec![from_f32(1.0); width as usize * height as usize * 3];
    let signed_sin = radians.sin();
    let signed_cos = radians.cos();
    for y in 0..height {
        for x in 0..width {
            let nx = (x as f32 + 0.5) / width as f32 * 2.0 - 1.0;
            let ny = (y as f32 + 0.5) / height as f32 * 2.0 - 1.0;
            if nx.abs() > inner_scale || ny.abs() > inner_scale { continue; }
            let local_x = nx / inner_scale * crop_width * 0.5;
            let local_y = ny / inner_scale * crop_height * 0.5;
            let source_x = center_x + signed_cos * local_x - signed_sin * local_y;
            let source_y = center_y + signed_sin * local_x + signed_cos * local_y;
            let x0 = source_x.floor().clamp(0.0, image.width.saturating_sub(1) as f32) as u32;
            let y0 = source_y.floor().clamp(0.0, image.height.saturating_sub(1) as f32) as u32;
            let x1 = (x0 + 1).min(image.width - 1);
            let y1 = (y0 + 1).min(image.height - 1);
            let (tx, ty) = (source_x - x0 as f32, source_y - y0 as f32);
            let target = (y * width + x) as usize * 3;
            for channel in 0..3 {
                let sample = |sx, sy| to_f32(image.data[(sy * image.width + sx) as usize * 3 + channel]);
                let top = sample(x0, y0) * (1.0 - tx) + sample(x1, y0) * tx;
                let bottom = sample(x0, y1) * (1.0 - tx) + sample(x1, y1) * tx;
                output[target + channel] = from_f32(top * (1.0 - ty) + bottom * ty);
            }
        }
    }
    let mut output = ImageBuf::from_data(width, height, output);
    apply_vignette(&mut output, composition);
    output
}

fn apply_vignette(image: &mut ImageBuf, composition: &Composition) {
    let amount = composition.vignette_amount.clamp(-100.0, 100.0) / 100.0;
    if amount == 0.0 { return; }
    let midpoint = composition.vignette_midpoint.clamp(0.0, 100.0) / 100.0;
    let feather = composition.vignette_feather.clamp(0.0, 100.0) / 100.0;
    let roundness = composition.vignette_roundness.clamp(-100.0, 100.0) / 100.0;
    let highlights = composition.vignette_highlights.clamp(0.0, 100.0) / 100.0;
    for y in 0..image.height {
        for x in 0..image.width {
            let nx = ((x as f32 + 0.5) / image.width as f32 * 2.0 - 1.0) * (1.0 - roundness * 0.35);
            let ny = ((y as f32 + 0.5) / image.height as f32 * 2.0 - 1.0) * (1.0 + roundness * 0.35);
            let radius = (nx * nx + ny * ny).sqrt() / 2.0f32.sqrt();
            let mask = ((radius - midpoint) / (feather * (1.0 - midpoint) + 0.001)).clamp(0.0, 1.0);
            let offset = (y * image.width + x) as usize * 3;
            let light = (to_f32(image.data[offset]) + to_f32(image.data[offset + 1]) + to_f32(image.data[offset + 2])) / 3.0;
            let protected = if amount < 0.0 { 1.0 - highlights * light.clamp(0.0, 1.0) } else { 1.0 };
            let factor = 1.0 + amount * mask * protected;
            for channel in 0..3 { image.data[offset + channel] = from_f32((to_f32(image.data[offset + channel]) * factor).clamp(0.0, 16.0)); }
        }
    }
}

#[derive(Default)]
struct AncillaryMetadata {
    jpeg_segments: Vec<Vec<u8>>,
    png_chunks: Vec<Vec<u8>>,
    xmp: Option<Vec<u8>>,
    iptc: Option<Vec<u8>>,
    exif: Option<little_exif::metadata::Metadata>,
}

fn extract_ancillary_metadata(input: &[u8]) -> AncillaryMetadata {
    const XMP: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
    const EXTENDED_XMP: &[u8] = b"http://ns.adobe.com/xmp/extension/\0";
    let mut metadata = AncillaryMetadata::default();

    if input.starts_with(&[0xff, 0xd8]) {
        let mut offset = 2;
        while offset + 4 <= input.len() && input[offset] == 0xff {
            let marker = input[offset + 1];
            if marker == 0xda || marker == 0xd9 {
                break;
            }
            let length = u16::from_be_bytes([input[offset + 2], input[offset + 3]]) as usize;
            if length < 2 || offset + 2 + length > input.len() {
                break;
            }
            let end = offset + 2 + length;
            let payload = &input[offset + 4..end];
            if marker == 0xe1 && (payload.starts_with(XMP) || payload.starts_with(EXTENDED_XMP)) {
                if payload.starts_with(XMP) {
                    metadata.xmp = Some(payload[XMP.len()..].to_vec());
                }
                metadata.jpeg_segments.push(input[offset..end].to_vec());
            } else if marker == 0xed {
                metadata.jpeg_segments.push(input[offset..end].to_vec());
            }
            offset = end;
        }
    } else if input.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        let mut offset = 8;
        while offset + 12 <= input.len() {
            let length = u32::from_be_bytes(input[offset..offset + 4].try_into().unwrap()) as usize;
            let Some(end) = png_chunk_end(offset, length, input.len()) else {
                break;
            };
            let kind = &input[offset + 4..offset + 8];
            if matches!(kind, b"tEXt" | b"zTXt" | b"iTXt" | b"tIME" | b"pHYs") {
                let chunk = input[offset..end].to_vec();
                if kind == b"iTXt" {
                    let data = &input[offset + 8..offset + 8 + length];
                    if data.starts_with(b"XML:com.adobe.xmp\0\0\0\0\0") {
                        metadata.xmp = Some(data[22..].to_vec());
                    }
                }
                metadata.png_chunks.push(chunk);
            }
            offset = end;
            if kind == b"IEND" {
                break;
            }
        }
    }

    if let Ok(mut decoder) = tiff::decoder::Decoder::new(Cursor::new(input)) {
        metadata.xmp = metadata
            .xmp
            .or_else(|| decoder.get_tag_u8_vec(tiff::tags::Tag::Unknown(700)).ok());
        metadata.iptc = decoder.get_tag_u8_vec(tiff::tags::Tag::Unknown(33723)).ok();
    }
    if metadata.xmp.is_none() {
        let source = rawler::rawsource::RawSource::new_from_slice(input);
        if let Ok(decoder) = rawler::get_decoder(&source) {
            metadata.xmp = decoder
                .xpacket(&source, &rawler::decoders::RawDecodeParams::default())
                .ok()
                .flatten();
        }
    }
    if let Some(source_type) =
        little_exif::filetype::FileExtension::auto_detect(&mut Cursor::new(input))
    {
        metadata.exif =
            little_exif::metadata::Metadata::new_from_vec(&jpeg_for_exif(input), source_type)
                .ok()
                .filter(|exif| exif.into_iter().next().is_some());
    }
    metadata
}

fn rotate_metadata(metadata: &mut AncillaryMetadata, quarter_turns: u8) {
    use little_exif::{exif_tag::ExifTag, metadata::Metadata};

    let turns = quarter_turns % 4;
    if turns == 0 {
        return;
    }
    let exif = metadata.exif.get_or_insert_with(Metadata::new);
    let mut orientation = exif
        .get_tag(&ExifTag::Orientation(Vec::new()))
        .next()
        .and_then(orientation_value)
        .unwrap_or(1);
    for _ in 0..turns {
        orientation = [6, 7, 8, 5, 2, 3, 4, 1][usize::from(orientation.clamp(1, 8) - 1)];
    }
    exif.set_tag(ExifTag::Orientation(vec![orientation]));
}

fn normalize_metadata_orientation(metadata: &mut AncillaryMetadata) {
    if let Some(exif) = &mut metadata.exif {
        exif.set_tag(little_exif::exif_tag::ExifTag::Orientation(vec![1]));
    }
}

fn orientation_value(tag: &little_exif::exif_tag::ExifTag) -> Option<u16> {
    match tag {
        little_exif::exif_tag::ExifTag::Orientation(values) => values.first().copied(),
        _ => None,
    }
}

fn embed_ancillary_metadata(
    mut output: Vec<u8>,
    format: &str,
    metadata: &AncillaryMetadata,
) -> Result<Vec<u8>, InspectError> {
    match format.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => {
            let mut segments = metadata.jpeg_segments.clone();
            if segments.is_empty() {
                if let Some(xmp) = &metadata.xmp {
                    let payload = [b"http://ns.adobe.com/xap/1.0/\0".as_slice(), xmp].concat();
                    if payload.len() + 2 <= u16::MAX as usize {
                        let mut segment = vec![0xff, 0xe1];
                        segment.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
                        segment.extend_from_slice(&payload);
                        segments.push(segment);
                    }
                }
            }
            let insert_at = jpeg_app_end(&output);
            for segment in segments.into_iter().rev() {
                output.splice(insert_at..insert_at, segment);
            }
        }
        "png" => {
            let mut chunks = metadata.png_chunks.clone();
            if chunks.is_empty() {
                if let Some(xmp) = &metadata.xmp {
                    let mut data = b"XML:com.adobe.xmp\0\0\0\0\0".to_vec();
                    data.extend_from_slice(xmp);
                    let mut chunk = Vec::with_capacity(data.len() + 12);
                    chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
                    chunk.extend_from_slice(b"iTXt");
                    chunk.extend_from_slice(&data);
                    let mut crc = crc32fast::Hasher::new();
                    crc.update(b"iTXt");
                    crc.update(&data);
                    chunk.extend_from_slice(&crc.finalize().to_be_bytes());
                    chunks.push(chunk);
                }
            }
            let ihdr_end =
                8 + 4 + 4 + u32::from_be_bytes(output[8..12].try_into().unwrap()) as usize + 4;
            for chunk in chunks.into_iter().rev() {
                output.splice(ihdr_end..ihdr_end, chunk);
            }
        }
        _ => {}
    }
    Ok(output)
}

fn jpeg_app_end(input: &[u8]) -> usize {
    let mut offset = 2;
    while offset + 4 <= input.len() && input[offset] == 0xff {
        let marker = input[offset + 1];
        if !(0xe0..=0xef).contains(&marker) {
            break;
        }
        let length = u16::from_be_bytes([input[offset + 2], input[offset + 3]]) as usize;
        let end = offset.saturating_add(2 + length);
        if length < 2 || end > input.len() {
            break;
        }
        offset = end;
    }
    offset
}

fn preserve_metadata(
    input: &[u8],
    mut output: Vec<u8>,
    format: &str,
    quarter_turns: u8,
    pixels_auto_oriented: bool,
) -> Result<Vec<u8>, InspectError> {
    use little_exif::{filetype::FileExtension, metadata::Metadata};

    let Some(source_type) = FileExtension::auto_detect(&mut Cursor::new(input)) else {
        return Ok(output);
    };
    let has_exif = source_type == FileExtension::TIFF
        || input.windows(6).any(|bytes| bytes == b"Exif\0\0")
        || input.windows(4).any(|bytes| bytes == b"eXIf");
    if !has_exif && quarter_turns % 4 == 0 {
        return Ok(output);
    }
    let output_type = match format.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => FileExtension::JPEG,
        "png" => FileExtension::PNG {
            as_zTXt_chunk: true,
        },
        "tif" | "tiff" => FileExtension::TIFF,
        _ => return Ok(output),
    };
    let source = jpeg_for_exif(input);
    let mut metadata =
        Metadata::new_from_vec(&source, source_type).unwrap_or_else(|_| Metadata::new());
    let mut ancillary = AncillaryMetadata {
        exif: Some(metadata),
        ..AncillaryMetadata::default()
    };
    if pixels_auto_oriented {
        normalize_metadata_orientation(&mut ancillary);
    }
    rotate_metadata(&mut ancillary, quarter_turns);
    metadata = portable_metadata(&ancillary.exif.take().unwrap());
    if (&metadata).into_iter().next().is_none() {
        return Ok(output);
    }
    metadata
        .write_to_vec(&mut output, output_type)
        .map_err(|error| InspectError::Metadata(error.to_string()))?;
    Ok(output)
}

fn portable_metadata(source: &little_exif::metadata::Metadata) -> little_exif::metadata::Metadata {
    use little_exif::metadata::Metadata;

    const STRUCTURAL: &[u16] = &[
        0x0100, 0x0101, 0x0102, 0x0103, 0x0106, 0x0111, 0x0115, 0x0116, 0x0117, 0x011a, 0x011b,
        0x0128, 0x014a, 0x0201, 0x0202, 0x8769, 0x8825, 0xa005, 0x83bb, 0x02bc, 0x8773,
        0x927c, 0xc634,
    ];
    let mut output = Metadata::new();
    for tag in source {
        if !STRUCTURAL.contains(&tag.as_u16()) && tag.value_as_u8_vec(&source.get_endian()).len() <= 60_000 {
            output.set_tag(tag.clone());
        }
    }
    output
}

fn jpeg_for_exif(input: &[u8]) -> Vec<u8> {
    if !input.starts_with(&[0xff, 0xd8]) {
        return input.to_vec();
    }
    let mut output = input[..2].to_vec();
    let mut offset = 2;
    while offset + 4 <= input.len() && input[offset] == 0xff {
        let marker = input[offset + 1];
        if marker == 0xda || marker == 0xd9 {
            output.extend_from_slice(&input[offset..]);
            return output;
        }
        let length = u16::from_be_bytes([input[offset + 2], input[offset + 3]]) as usize;
        let end = offset.saturating_add(2 + length);
        if length < 2 || end > input.len() {
            return input.to_vec();
        }
        let payload = &input[offset + 4..end];
        if marker != 0xed && (marker != 0xe1 || payload.starts_with(b"Exif\0\0")) {
            output.extend_from_slice(&input[offset..end]);
        }
        offset = end;
    }
    input.to_vec()
}

#[wasm_bindgen]
impl BrowserEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(
        film_json: &[u8],
        print_json: &[u8],
        neutral_filters_json: &[u8],
        spectral_lut_npy: &[u8],
        settings_json: Option<String>,
    ) -> Result<BrowserEngine, JsValue> {
        let source = EngineSource {
            film: film_json.to_vec(),
            print: print_json.to_vec(),
            filters: neutral_filters_json.to_vec(),
            lut: spectral_lut_npy.to_vec(),
        };
        build_pipeline(
            &source.film,
            &source.print,
            &source.filters,
            &source.lut,
            settings_json,
        )
        .map(|pipeline| Self {
            pipeline,
            gpu: None,
            source,
            raw_development: RawDevelopment { camera_white_balance: true, ..Default::default() },
        })
        .map_err(|error| JsValue::from_str(&error))
    }

    pub fn update_settings(&mut self, settings_json: &str) -> Result<(), JsValue> {
        let params = browser_params(
            serde_json::from_str(settings_json)
                .map_err(|error| JsValue::from_str(&format!("invalid settings: {error}")))?,
        );
        let mut previous = serde_json::to_value(&self.pipeline.params).unwrap();
        let mut next = serde_json::to_value(&params).unwrap();
        for key in ["io", "adjustments", "composition"] {
            previous.as_object_mut().unwrap().remove(key);
            next.as_object_mut().unwrap().remove(key);
        }
        self.pipeline = if previous == next {
            self.pipeline.clone().with_params(params)
        } else {
            build_pipeline(
                &self.source.film,
                &self.source.print,
                &self.source.filters,
                &self.source.lut,
                Some(settings_json.into()),
            )
            .map_err(|error| JsValue::from_str(&error))?
        };
        Ok(())
    }

    pub fn set_raw_development(&mut self, white_balance: &str, demosaic: &str) {
        self.raw_development = RawDevelopment {
            camera_white_balance: white_balance != "uncorrected",
            demosaic: if demosaic == "superpixel" { RawDemosaic::Superpixel } else { RawDemosaic::Ppg },
        };
    }

    fn linear_pipeline(&self) -> Pipeline {
        let mut params = self.pipeline.params.clone();
        params.io.output_cctf_encoding = false;
        self.pipeline.clone().with_params(params)
    }

    fn encode_output(
        &self,
        image: ImageBuf,
        format: &str,
        quality: u8,
        metadata: &AncillaryMetadata,
    ) -> Result<Vec<u8>, InspectError> {
        let mut image = apply_composition(image, &self.pipeline.params.composition);
        let color_space = self.pipeline.params.io.output_color_space.as_str();
        let encoded = self.pipeline.params.io.output_cctf_encoding;
        for value in &mut image.data {
            *value = from_f32(encode_output_channel(to_f32(*value), color_space, encoded));
        }
        let profile = icc::profile(color_space, encoded);
        encode_image_buf(&image, format, quality, &profile, metadata)
    }

    fn finish_output(
        &self,
        input: &[u8],
        encoded: Vec<u8>,
        format: &str,
        ancillary: &AncillaryMetadata,
        quarter_turns: u8,
        pixels_auto_oriented: bool,
    ) -> Result<Vec<u8>, InspectError> {
        let metadata = if matches!(format.to_ascii_lowercase().as_str(), "tif" | "tiff") {
            encoded
        } else {
            preserve_metadata(input, encoded, format, quarter_turns, pixels_auto_oriented)?
        };
        if !matches!(format.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png") {
            return Ok(metadata);
        }
        let profile = icc::profile(
            &self.pipeline.params.io.output_color_space,
            self.pipeline.params.io.output_cctf_encoding,
        );
        embed_ancillary_metadata(embed_icc(metadata, format, &profile)?, format, ancillary)
    }

    fn process_reference_inner(
        &self,
        input: &[u8],
        format: &str,
        quality: u8,
        scale: f32,
        quarter_turns: u8,
    ) -> Result<Vec<u8>, InspectError> {
        let pixels_auto_oriented = raw_orientation_from_bytes(input).is_some();
        let mut ancillary = extract_ancillary_metadata(input);
        if pixels_auto_oriented {
            normalize_metadata_orientation(&mut ancillary);
        }
        rotate_metadata(&mut ancillary, quarter_turns);
        let decoded = decode_standard_image(input, scale, self.raw_development)?;
        let processed = self.process_reference_decoded(decoded, 4_000_000);
        let encoded = self.encode_output(processed, format, quality, &ancillary)?;
        self.finish_output(
            input,
            encoded,
            format,
            &ancillary,
            quarter_turns,
            pixels_auto_oriented,
        )
    }

    fn process_reference_decoded(&self, mut decoded: ImageBuf, max_pixels: u64) -> ImageBuf {
        apply_negative_film_adjustments(&mut decoded, &self.pipeline.params.adjustments);
        if u64::from(decoded.width) * u64::from(decoded.height) > max_pixels {
            self.process_reference_strips(decoded)
        } else {
            self.linear_pipeline().process(decoded, &CpuBackend)
        }
    }

    fn prepare_strips(&self, image: ImageBuf) -> (Pipeline, ImageBuf, u32) {
        let image = resize_image_buf(image, self.pipeline.params.io.upscale_factor);
        let mut params = self.pipeline.params.clone();
        params.io.upscale_factor = 1.0;
        params.io.output_cctf_encoding = false;
        if params.camera.auto_exposure {
            let matrix = spektrafilm_core::stages::filming::input_colorspace_to_xyz(
                &params.io.input_color_space,
            );
            params.camera.exposure_compensation_ev +=
                spektrafilm_core::stages::filming::measure_autoexposure_ev(
                    &image,
                    &matrix,
                    &params.camera.auto_exposure_method,
                );
            params.camera.auto_exposure = false;
        }
        let pixel_um = params.camera.film_format_mm * 1000.0 / image.width.max(image.height) as f32;
        let mut sigma = params
            .scanner
            .lens_blur
            .max(params.scanner.unsharp_mask[0])
            .max(params.film_render.grain.blur)
            .max(params.print_render.glare.blur)
            .max(params.camera.lens_blur_um / pixel_um);
        if params.film_render.halation.active {
            let halation = &params.film_render.halation;
            sigma = sigma.max(
                (halation
                    .halation_first_sigma_um
                    .iter()
                    .copied()
                    .fold(0.0, f64::max)
                    * halation.halation_spatial_scale
                    * (halation.halation_n_bounces.max(1) as f64).sqrt()
                    / pixel_um as f64) as f32,
            );
            sigma = sigma.max(
                (halation.scatter_tail_um.iter().copied().fold(0.0, f64::max)
                    * halation.scatter_spatial_scale
                    / pixel_um as f64) as f32,
            );
        }
        if params.film_render.dir_couplers.active {
            sigma = sigma
                .max((params.film_render.dir_couplers.diffusion_tail_um / pixel_um as f64) as f32);
        }
        if params.camera.diffusion_filter.active || params.enlarger.diffusion_filter.active {
            sigma = sigma.max(128.0);
        }
        let halo = (sigma * 3.0).ceil().max(16.0) as u32;
        (self.pipeline.clone().with_params(params), image, halo)
    }

    fn process_reference_strips(&self, image: ImageBuf) -> ImageBuf {
        const MAX_PIXELS: u64 = 4_000_000;
        let (mut pipeline, image, halo) = self.prepare_strips(image);
        let (horizontal, strips) = strips(image.width, image.height, MAX_PIXELS, halo);
        let mut output = vec![from_f32(0.0); image.data.len()];
        let base_seeds = [
            pipeline.params.film_render.grain.seed,
            pipeline.params.film_render.glare.seed,
            pipeline.params.print_render.glare.seed,
        ];
        for strip in strips {
            seed_strip(&mut pipeline, strip, base_seeds);
            let processed = pipeline.process(extract_strip(&image, horizontal, strip), &CpuBackend);
            insert_strip(
                &mut output,
                image.width,
                image.height,
                horizontal,
                strip,
                &processed,
            );
        }
        ImageBuf::from_data(image.width, image.height, output)
    }

    // Browser-only async WebGPU glue is exercised by the Fast GPU Playwright matrix.
    #[cfg(not(coverage))]
    async fn process_fast_strips(
        &self,
        image: ImageBuf,
        gpu: &spektrafilm_gpu::wgpu_backend::WgpuBackend,
    ) -> Result<ImageBuf, JsValue> {
        const MAX_PIXELS: u64 = 120 * 1024 * 1024 / 12;
        let (mut pipeline, image, halo) = self.prepare_strips(image);
        let (horizontal, strips) = strips(image.width, image.height, MAX_PIXELS, halo);
        let mut output = vec![from_f32(0.0); image.data.len()];
        let base_seeds = [
            pipeline.params.film_render.grain.seed,
            pipeline.params.film_render.glare.seed,
            pipeline.params.print_render.glare.seed,
        ];
        for strip in strips {
            seed_strip(&mut pipeline, strip, base_seeds);
            let processed = pipeline
                .process_gpu_async(extract_strip(&image, horizontal, strip), gpu)
                .await
                .ok_or_else(|| {
                    JsValue::from_str("this profile cannot use the resident GPU chain")
                })?;
            insert_strip(
                &mut output,
                image.width,
                image.height,
                horizontal,
                strip,
                &processed,
            );
        }
        Ok(ImageBuf::from_data(image.width, image.height, output))
    }

    #[cfg(not(coverage))]
    pub async fn enable_gpu(&mut self) -> Result<String, JsValue> {
        self.gpu = spektrafilm_gpu::wgpu_backend::WgpuBackend::new_async().await;
        self.gpu
            .as_ref()
            .map(|_| "ready".into())
            .ok_or_else(|| JsValue::from_str("no compatible WebGPU adapter"))
    }

    pub fn process_reference(
        &self,
        input: &[u8],
        format: &str,
        quality: u8,
        scale: f32,
    ) -> Result<Vec<u8>, JsValue> {
        self.process_reference_inner(input, format, quality, scale, 0)
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    pub fn process_reference_rotated(
        &self,
        input: &[u8],
        format: &str,
        quality: u8,
        scale: f32,
        quarter_turns: u8,
    ) -> Result<Vec<u8>, JsValue> {
        self.process_reference_inner(input, format, quality, scale, quarter_turns)
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    #[cfg(not(coverage))]
    pub async fn process_fast(
        &self,
        input: &[u8],
        format: &str,
        quality: u8,
        scale: f32,
        preserve_metadata: bool,
    ) -> Result<Vec<u8>, JsValue> {
        self.process_fast_rotated(input, format, quality, scale, preserve_metadata, 0)
            .await
    }

    #[cfg(not(coverage))]
    pub async fn process_fast_rotated(
        &self,
        input: &[u8],
        format: &str,
        quality: u8,
        scale: f32,
        preserve_metadata: bool,
        quarter_turns: u8,
    ) -> Result<Vec<u8>, JsValue> {
        let gpu = self
            .gpu
            .as_ref()
            .ok_or_else(|| JsValue::from_str("WebGPU is not initialized"))?;
        let pixels_auto_oriented = raw_orientation_from_bytes(input).is_some();
        let mut ancillary = if preserve_metadata || quarter_turns % 4 != 0 {
            extract_ancillary_metadata(input)
        } else {
            AncillaryMetadata::default()
        };
        if pixels_auto_oriented {
            normalize_metadata_orientation(&mut ancillary);
        }
        rotate_metadata(&mut ancillary, quarter_turns);
        let mut decoded = decode_standard_image(input, scale, self.raw_development)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        apply_negative_film_adjustments(&mut decoded, &self.pipeline.params.adjustments);
        let processed =
            if u64::from(decoded.width) * u64::from(decoded.height) > 120 * 1024 * 1024 / 12 {
                self.process_fast_strips(decoded, gpu).await?
            } else {
                self.linear_pipeline()
                    .process_gpu_async(decoded, gpu)
                    .await
                    .ok_or_else(|| {
                        JsValue::from_str("this profile cannot use the resident GPU chain")
                    })?
            };
        let encoded = self
            .encode_output(processed, format, quality, &ancillary)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        self.finish_output(
            if preserve_metadata || quarter_turns % 4 != 0 {
                input
            } else {
                &[]
            },
            encoded,
            format,
            &ancillary,
            quarter_turns,
            pixels_auto_oriented,
        )
        .map_err(|error| JsValue::from_str(&error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, GenericImageView, ImageBuffer, ImageFormat, Rgb};
    use std::io::Cursor;

    #[test]
    fn portable_device_limits_preflight_before_allocation() {
        let safe = inspect_dimensions(6000, 4000, DeviceLimits::default()).unwrap();
        assert_eq!(safe.estimated_working_bytes, 1_920_000_000);
        assert!(safe.requires_resize);
        assert!(safe.tile_rows < safe.height);

        let modest = inspect_dimensions(3000, 2000, DeviceLimits::default()).unwrap();
        assert!(!modest.requires_resize);
        assert!(modest.tile_rows > 0);
        assert!(modest.tile_rows <= modest.height);
        assert_eq!(
            inspect_dimensions(0, 0, DeviceLimits::default())
                .unwrap()
                .tile_rows,
            0
        );
        assert_eq!(inspect_dimensions(1, 0, DeviceLimits::default()).unwrap().tile_rows, 1);
        assert!(
            inspect_dimensions(
                1,
                1,
                DeviceLimits {
                    memory_budget_bytes: 0,
                    ..DeviceLimits::default()
                }
            )
            .is_err()
        );
    }

    #[test]
    fn hostile_png_lengths_and_wasm_budget_are_bounded() {
        assert_eq!(png_chunk_end(8, usize::MAX, 32), None);
        assert_eq!(png_chunk_end(8, 4, 24), Some(24));
        assert_eq!(
            clamp_browser_memory_budget(8 * 1024_u64.pow(3)),
            2 * 1024_u64.pow(3)
        );
    }

    #[test]
    fn image_preflight_reads_dimensions_without_decoding_pixels() {
        let image = DynamicImage::ImageRgb8(ImageBuffer::from_pixel(2, 3, Rgb([1, 2, 3])));
        let mut encoded = Cursor::new(Vec::new());
        image.write_to(&mut encoded, ImageFormat::Png).unwrap();
        let mut header_only = encoded.into_inner();
        let idat = header_only
            .windows(4)
            .position(|bytes| bytes == b"IDAT")
            .unwrap();
        header_only[idat + 4] ^= 0xff;
        assert!(image::load_from_memory(&header_only).is_err());
        let inspected = inspect_image_inner(&header_only, DeviceLimits::default()).unwrap();
        assert_eq!((inspected.width, inspected.height), (2, 3));
    }

    #[test]
    fn browser_exports_delegate_to_native_tested_paths() {
        let dng = include_bytes!("../../../web/tests/fixtures/canon-a410-chdk.dng");
        assert_eq!(version(), env!("CARGO_PKG_VERSION"));
        let settings = default_settings_json().unwrap();
        assert!(settings.contains("film_render"));
        assert!(settings.contains("\"adjustments\""));
        assert!(portable_limits_json().contains("maxWorkgroupInvocations"));
        assert!(inspect_image(dng, None).unwrap().contains("megapixels"));
        assert!(
            inspect_image(dng, Some("{}".into()))
                .unwrap()
                .contains("megapixels")
        );
        #[cfg(not(coverage))]
        {
            let embedded = raw_preview(dng, 2400, false, true, "ppg").unwrap();
            let embedded = image::load_from_memory(&embedded).unwrap();
            assert!(embedded.width().max(embedded.height()) >= 1200);
            assert!(!raw_preview(dng, 64, true, true, "ppg").unwrap().is_empty());
        }
        assert!(!encode_rgb8(1, 1, &[1, 2, 3], "png", 95).unwrap().is_empty());

        let film = include_bytes!("../../../data/profiles/kodak_portra_400.json");
        let print = include_bytes!("../../../data/profiles/kodak_portra_endura.json");
        let filters = include_bytes!("../../../data/filters/neutral_print_filters.json");
        let lut = include_bytes!("../../../data/luts/spectral_upsampling/irradiance_xy_tc.npy");
        assert!(
            calibrate_pipeline(film, print, filters, lut, None)
                .unwrap()
                .contains("film")
        );
        let engine = BrowserEngine::new(film, print, filters, lut, None).unwrap();
        assert!(
            !engine
                .process_reference(dng, "jpeg", 95, 0.02)
                .unwrap()
                .is_empty()
        );
        assert!(
            !engine
                .process_reference_rotated(dng, "png", 95, 0.02, 1)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn every_lightroom_adjustment_changes_pixels_without_unbounded_values() {
        let source = ImageBuf::from_data(
            3,
            3,
            vec![
                from_f32(0.05), from_f32(0.10), from_f32(0.20),
                from_f32(0.15), from_f32(0.30), from_f32(0.10),
                from_f32(0.80), from_f32(0.55), from_f32(0.35),
                from_f32(0.30), from_f32(0.20), from_f32(0.50),
                from_f32(0.45), from_f32(0.70), from_f32(0.25),
                from_f32(0.90), from_f32(0.75), from_f32(0.60),
                from_f32(0.02), from_f32(0.03), from_f32(0.04),
                from_f32(0.40), from_f32(0.45), from_f32(0.55),
                from_f32(0.95), from_f32(0.85), from_f32(0.70),
            ],
        );
        let controls = [
            Adjustments { temperature: 75.0, ..Default::default() },
            Adjustments { tint: 75.0, ..Default::default() },
            Adjustments { contrast: 75.0, ..Default::default() },
            Adjustments { highlights: 75.0, ..Default::default() },
            Adjustments { shadows: 75.0, ..Default::default() },
            Adjustments { whites: 75.0, ..Default::default() },
            Adjustments { blacks: 75.0, ..Default::default() },
            Adjustments { saturation: 75.0, ..Default::default() },
            Adjustments { vibrance: 75.0, ..Default::default() },
            Adjustments { clarity: 75.0, ..Default::default() },
            Adjustments { dehaze: 75.0, ..Default::default() },
        ];
        let mut unchanged = source.clone();
        apply_adjustments(&mut unchanged, &Adjustments::default());
        assert_eq!(unchanged.data, source.data);
        for control in controls {
            let mut adjusted = source.clone();
            apply_adjustments(&mut adjusted, &control);
            assert_ne!(adjusted.data, source.data);
            assert!(adjusted.data.iter().all(|value| {
                let value = to_f32(*value);
                value.is_finite() && value >= 0.0
            }));
        }
    }

    #[test]
    fn shadows_lift_detail_without_a_grey_veil_or_highlight_shift() {
        let mut image = ImageBuf::from_data(
            4,
            1,
            [0.0, 0.05, 0.25, 0.9]
                .into_iter()
                .flat_map(|value| [from_f32(value); 3])
                .collect(),
        );
        apply_adjustments(
            &mut image,
            &Adjustments { shadows: 100.0, ..Default::default() },
        );
        let values: Vec<f32> = image.data.chunks_exact(3).map(|rgb| to_f32(rgb[0])).collect();

        assert_eq!(values[0], 0.0);
        assert!(values[1] > 0.10 && values[1] < 0.25, "shadow became {}", values[1]);
        assert!(values[2] > 0.35 && values[2] < 0.75, "midtone became {}", values[2]);
        assert!((values[3] - 0.9).abs() < 1e-6, "highlight became {}", values[3]);
        assert!(values.iter().all(|value| value.is_finite() && *value >= 0.0));
    }

    #[test]
    fn blacks_adjust_deep_tones_without_a_grey_veil() {
        let source = ImageBuf::from_data(
            4,
            1,
            [0.0, 0.05, 0.25, 0.9]
                .into_iter()
                .flat_map(|value| [from_f32(value); 3])
                .collect(),
        );
        let adjusted = |amount| {
            let mut image = source.clone();
            apply_adjustments(
                &mut image,
                &Adjustments { blacks: amount, ..Default::default() },
            );
            image.data.chunks_exact(3).map(|rgb| to_f32(rgb[0])).collect::<Vec<_>>()
        };
        let raised = adjusted(100.0);
        let lowered = adjusted(-100.0);

        assert_eq!(raised[0], 0.0);
        assert!(raised[1] > 0.05 && raised[1] < 0.15, "black became {}", raised[1]);
        assert!(raised[2] > 0.25 && raised[2] < 0.4, "midtone became {}", raised[2]);
        assert!((raised[3] - 0.9).abs() < 1e-6, "highlight became {}", raised[3]);
        assert!(lowered[1] < 0.05);
        assert!(raised.iter().chain(&lowered).all(|value| value.is_finite() && *value >= 0.0));
    }

    #[test]
    fn highlights_make_a_visible_localized_change_in_both_directions() {
        let source = ImageBuf::from_data(
            3,
            1,
            [0.05, 0.5, 0.9]
                .into_iter()
                .flat_map(|value| [from_f32(value); 3])
                .collect(),
        );
        let adjusted = |amount| {
            let mut image = source.clone();
            apply_adjustments(
                &mut image,
                &Adjustments { highlights: amount, ..Default::default() },
            );
            image.data.chunks_exact(3).map(|rgb| to_f32(rgb[0])).collect::<Vec<_>>()
        };
        let raised = adjusted(100.0);
        let lowered = adjusted(-100.0);

        assert!((raised[0] - 0.05).abs() < 1e-6);
        assert!((lowered[0] - 0.05).abs() < 1e-6);
        assert!(raised[1] > 0.6 && raised[1] < 1.0, "midtone became {}", raised[1]);
        assert!(raised[2] > 1.5, "highlight only reached {}", raised[2]);
        assert!(lowered[2] < 0.6, "highlight only fell to {}", lowered[2]);
    }

    #[test]
    fn lightroom_adjustments_run_on_the_linear_scene_before_simulation() {
        let mut params = browser_default_params();
        params.camera.auto_exposure = false;
        params.film_render.grain.active = false;
        params.film_render.halation.active = false;
        params.film_render.dir_couplers.active = false;
        params.print_render.glare.active = false;
        params.scanner.unsharp_mask = [0.0, 0.0];
        params.adjustments.shadows = 100.0;
        let engine = BrowserEngine::new(
            include_bytes!("../../../data/profiles/kodak_portra_400.json"),
            include_bytes!("../../../data/profiles/kodak_portra_endura.json"),
            include_bytes!("../../../data/filters/neutral_print_filters.json"),
            include_bytes!("../../../data/luts/spectral_upsampling/irradiance_xy_tc.npy"),
            Some(serde_json::to_string(&params).unwrap()),
        )
        .unwrap();
        let source = ImageBuf::from_data(
            2,
            1,
            [0.05, 0.25]
                .into_iter()
                .flat_map(|value| [from_f32(value); 3])
                .collect(),
        );
        let mut adjusted_source = source.clone();
        apply_negative_film_adjustments(&mut adjusted_source, &params.adjustments);
        let expected = engine.linear_pipeline().process(adjusted_source, &CpuBackend);

        assert_eq!(engine.process_reference_decoded(source, 4_000_000).data, expected.data);
    }

    #[test]
    fn saturation_does_not_change_exposure_when_dehaze_is_zero() {
        let source = ImageBuf::from_data(
            2,
            1,
            vec![
                from_f32(0.3), from_f32(0.4), from_f32(0.5),
                from_f32(0.5), from_f32(0.4), from_f32(0.3),
            ],
        );
        let luminance = |image: &ImageBuf| image.data.chunks_exact(3).map(|rgb| {
            0.2126 * to_f32(rgb[0]) + 0.7152 * to_f32(rgb[1]) + 0.0722 * to_f32(rgb[2])
        }).sum::<f32>();
        let before = luminance(&source);
        let mut adjusted = source;
        apply_adjustments(&mut adjusted, &Adjustments { saturation: 75.0, ..Default::default() });
        let difference = (luminance(&adjusted) - before).abs();
        assert!(difference < 1e-5, "luminance changed by {difference}");
    }

    #[test]
    fn composition_crops_rotates_repositions_and_adds_a_white_border() {
        let source = ImageBuf::from_data(20, 12, (0..20 * 12 * 3).map(|value| from_f32(value as f32 / 720.0)).collect());
        let unchanged = apply_composition(source.clone(), &Composition::default());
        assert_eq!(unchanged.data, source.data);
        let square = apply_composition(source.clone(), &Composition { aspect: "1:1".into(), ..Default::default() });
        assert_eq!((square.width, square.height), (12, 12));
        let rotated = apply_composition(source.clone(), &Composition { straighten_degrees: 5.0, ..Default::default() });
        assert_ne!(rotated.data, source.data);
        let cropped = apply_composition(source.clone(), &Composition { crop_scale: 75.0, crop_x: 100.0, crop_y: -100.0, ..Default::default() });
        assert!(cropped.width < source.width && cropped.height < source.height);
        let bordered = apply_composition(source, &Composition { border: 20.0, ..Default::default() });
        assert_eq!((bordered.width, bordered.height), (25, 15));
        assert_eq!(bordered.get(0, 0), [from_f32(1.0); 3]);
        let black = ImageBuf::from_data(20, 12, vec![from_f32(0.0); 20 * 12 * 3]);
        let instagram = apply_composition(black, &Composition { aspect: "5:4".into(), border: 20.0, ..Default::default() });
        assert_eq!((instagram.width, instagram.height), (25, 20));
        assert_eq!(instagram.data.chunks_exact(3).filter(|pixel| pixel[0] == from_f32(0.0)).count(), 20 * 12);
        let portrait = ImageBuf::from_data(12, 20, vec![from_f32(0.0); 12 * 20 * 3]);
        let portrait = apply_composition(portrait, &Composition { aspect: "4:5".into(), border: 20.0, ..Default::default() });
        assert_eq!((portrait.width, portrait.height), (20, 25));
        assert_eq!(portrait.data.chunks_exact(3).filter(|pixel| pixel[0] == from_f32(0.0)).count(), 12 * 20);
        let white = ImageBuf::from_data(20, 12, vec![from_f32(0.5); 20 * 12 * 3]);
        let vignetted = apply_composition(white, &Composition {
            vignette_amount: -100.0,
            vignette_midpoint: 50.0,
            vignette_roundness: 0.0,
            vignette_feather: 50.0,
            vignette_highlights: 0.0,
            border: 20.0,
            ..Default::default()
        });
        assert!(to_f32(vignetted.get(3, 3)[0]) < to_f32(vignetted.get(vignetted.width / 2, vignetted.height / 2)[0]));
        assert_eq!(vignetted.get(0, 0), [from_f32(1.0); 3]);
    }

    #[test]
    fn overlapped_strips_reassemble_without_resizing() {
        for (width, height) in [(8, 5), (5, 8)] {
            let source: Vec<Scalar> = (0..width * height * 3)
                .map(|value| from_f32(value as f32))
                .collect();
            let image = ImageBuf::from_data(width, height, source.clone());
            let (horizontal, planned) = strips(width, height, 24, 1);
            let mut output = vec![from_f32(0.0); source.len()];
            for strip in planned {
                let tile = extract_strip(&image, horizontal, strip);
                insert_strip(&mut output, width, height, horizontal, strip, &tile);
            }
            assert_eq!(output, source);
        }

        let mut engine = BrowserEngine::new(
            include_bytes!("../../../data/profiles/kodak_portra_400.json"),
            include_bytes!("../../../data/profiles/kodak_portra_endura.json"),
            include_bytes!("../../../data/filters/neutral_print_filters.json"),
            include_bytes!("../../../data/luts/spectral_upsampling/irradiance_xy_tc.npy"),
            None,
        )
        .unwrap();
        let source = ImageBuf::from_data(2, 2, vec![from_f32(0.25); 12]);
        let (_, resized, halo) = engine.prepare_strips(source.clone());
        assert_eq!((resized.width, resized.height), (2, 2));
        assert!(halo >= 16);
        assert_eq!(
            engine.process_reference_strips(source.clone()).data.len(),
            12
        );
        assert_eq!(
            engine
                .process_reference_decoded(source.clone(), 1)
                .data
                .len(),
            12
        );
        engine.pipeline.params.camera.diffusion_filter.active = true;
        assert!(engine.prepare_strips(source).2 >= 384);
    }

    #[test]
    fn tiled_stochastic_fields_do_not_restart() {
        let engine = BrowserEngine::new(
            include_bytes!("../../../data/profiles/kodak_portra_400.json"),
            include_bytes!("../../../data/profiles/kodak_portra_endura.json"),
            include_bytes!("../../../data/filters/neutral_print_filters.json"),
            include_bytes!("../../../data/luts/spectral_upsampling/irradiance_xy_tc.npy"),
            None,
        )
        .unwrap();
        let strip = Strip {
            core_start: 100,
            core_end: 200,
            input_start: 84,
            input_end: 216,
        };
        let mut seeded = engine.pipeline.clone();
        let base = [
            seeded.params.film_render.grain.seed,
            seeded.params.film_render.glare.seed,
            seeded.params.print_render.glare.seed,
        ];
        seed_strip(&mut seeded, strip, base);
        assert_ne!(
            seeded.params.film_render.grain.seed,
            engine.pipeline.params.film_render.grain.seed
        );
        assert_ne!(
            seeded.params.film_render.glare.seed,
            engine.pipeline.params.film_render.glare.seed
        );
        assert_ne!(
            seeded.params.print_render.glare.seed,
            engine.pipeline.params.print_render.glare.seed
        );
    }

    #[test]
    fn settings_update_recalibrates_print_filters() {
        let mut engine = BrowserEngine::new(
            include_bytes!("../../../data/profiles/kodak_portra_400.json"),
            include_bytes!("../../../data/profiles/kodak_portra_endura.json"),
            include_bytes!("../../../data/filters/neutral_print_filters.json"),
            include_bytes!("../../../data/luts/spectral_upsampling/irradiance_xy_tc.npy"),
            None,
        )
        .unwrap();
        let before = engine.pipeline.print_illuminant_slice().to_vec();
        let mut params = engine.pipeline.params.clone();
        params.enlarger.y_filter_shift = 50.0;
        params.enlarger.m_filter_shift = -25.0;
        engine
            .update_settings(&serde_json::to_string(&params).unwrap())
            .unwrap();
        assert_ne!(engine.pipeline.print_illuminant_slice(), before);
        let mut io_only = engine.pipeline.params.clone();
        io_only.io.output_color_space = "Rec. 2020".into();
        engine
            .update_settings(&serde_json::to_string(&io_only).unwrap())
            .unwrap();
    }

    fn golden_signature(engine: &BrowserEngine) -> (u32, u32, u64, [u64; 3], u64) {
        let output = engine
            .process_reference_inner(
                include_bytes!("../../../web/tests/fixtures/canon-a410-chdk.dng"),
                "png",
                95,
                0.08,
                0,
            )
            .unwrap();
        let image = image::load_from_memory(&output).unwrap().to_rgb8();
        let mut hash = 0xcbf29ce484222325u64;
        let mut sums = [0u64; 3];
        let mut channel_spread = 0u64;
        for pixel in image.pixels() {
            for channel in 0..3 {
                hash = (hash ^ u64::from(pixel[channel])).wrapping_mul(0x100000001b3);
                sums[channel] += u64::from(pixel[channel]);
            }
            channel_spread +=
                u64::from(pixel[0].abs_diff(pixel[1])) + u64::from(pixel[1].abs_diff(pixel[2]));
        }
        (image.width(), image.height(), hash, sums, channel_spread)
    }

    #[test]
    fn stock_dng_golden_reference_presets() {
        let mut engine = BrowserEngine::new(
            include_bytes!("../../../data/profiles/kodak_portra_400.json"),
            include_bytes!("../../../data/profiles/kodak_portra_endura.json"),
            include_bytes!("../../../data/filters/neutral_print_filters.json"),
            include_bytes!("../../../data/luts/spectral_upsampling/irradiance_xy_tc.npy"),
            None,
        )
        .unwrap();
        let default = golden_signature(&engine);
        let base_params = engine.pipeline.params.clone();
        let mut params = base_params.clone();
        params.camera.exposure_compensation_ev = 1.0;
        engine
            .update_settings(&serde_json::to_string(&params).unwrap())
            .unwrap();
        let exposure = golden_signature(&engine);
        params.enlarger.y_filter_shift = 50.0;
        params.enlarger.m_filter_shift = -25.0;
        engine
            .update_settings(&serde_json::to_string(&params).unwrap())
            .unwrap();
        let warmth = golden_signature(&engine);

        params = base_params.clone();
        params.film_render.grain.active = false;
        engine
            .update_settings(&serde_json::to_string(&params).unwrap())
            .unwrap();
        let grain_off = golden_signature(&engine);
        params = base_params.clone();
        params.film_render.halation.active = false;
        engine
            .update_settings(&serde_json::to_string(&params).unwrap())
            .unwrap();
        let halation_off = golden_signature(&engine);
        params = base_params;
        params.scanner.unsharp_mask[0] = 1.5;
        engine
            .update_settings(&serde_json::to_string(&params).unwrap())
            .unwrap();
        let sharpness = golden_signature(&engine);

        let mut trix_params = RuntimeParams::default();
        trix_params.io.scan_film = true;
        let trix = BrowserEngine::new(
            include_bytes!("../../../data/profiles/kodak_trix.json"),
            include_bytes!("../../../data/profiles/kodak_portra_endura.json"),
            include_bytes!("../../../data/filters/neutral_print_filters.json"),
            include_bytes!("../../../data/luts/spectral_upsampling/irradiance_xy_tc.npy"),
            Some(serde_json::to_string(&trix_params).unwrap()),
        )
        .unwrap();
        let trix = golden_signature(&trix);
        let bw_print = BrowserEngine::new(
            include_bytes!("../../../data/profiles/kodak_portra_400.json"),
            include_bytes!("../../../data/profiles/kodak_2302.json"),
            include_bytes!("../../../data/filters/neutral_print_filters.json"),
            include_bytes!("../../../data/luts/spectral_upsampling/irradiance_xy_tc.npy"),
            None,
        )
        .unwrap();
        let bw_print = golden_signature(&bw_print);
        assert_eq!(
            bw_print,
            (
                164,
                123,
                10611900735878693405,
                [1576684, 1576927, 1576885],
                285
            )
        );
        assert!(bw_print.4 < 500, "B&W paper rendered coloured pixels");
        assert_eq!(
            default,
            (
                164,
                123,
                14283919497219789252,
                [1484438, 1076376, 645903],
                969945
            )
        );
        assert_eq!(
            exposure,
            (
                164,
                123,
                11226509621849799021,
                [1497258, 1083306, 649006],
                973524
            )
        );
        assert_eq!(
            warmth,
            (
                164,
                123,
                8478377253799481580,
                [1102702, 759363, 1389314],
                1105896
            )
        );
        assert_eq!(
            trix,
            (
                164,
                123,
                3671413219038802872,
                [2653296, 2653743, 2653676],
                514
            )
        );
        assert_eq!(
            grain_off,
            (
                164,
                123,
                16890400267027008821,
                [1487985, 1086764, 656821],
                1006590
            )
        );
        assert_eq!(
            halation_off,
            (
                164,
                123,
                7313851347835300666,
                [1483770, 1076420, 645955],
                969501
            )
        );
        assert_eq!(
            sharpness,
            (
                164,
                123,
                808426594210045148,
                [1415951, 1026671, 623071],
                1005376
            )
        );
        assert!(trix.4 < default.4 / 8);
    }

    #[test]
    fn byte_input_reports_dimensions() {
        let image = DynamicImage::ImageRgb8(ImageBuffer::from_pixel(3, 2, Rgb([1, 2, 3])));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();

        let inspected = inspect_image_inner(bytes.get_ref(), DeviceLimits::default()).unwrap();
        assert_eq!((inspected.width, inspected.height), (3, 2));
        assert!(!inspected.requires_resize);
    }

    #[test]
    fn dng_uses_sensor_data_instead_of_embedded_thumbnail() {
        let bytes = include_bytes!("../../../web/tests/fixtures/canon-a410-chdk.dng");
        let inspected = inspect_image_inner(bytes, DeviceLimits::default()).unwrap();
        assert!(inspected.width > 1_000);
        assert!(inspected.height > 1_000);
        let decoded = decode_standard_image(bytes, 0.1, RawDevelopment::default()).unwrap();
        assert!(decoded.width > 100);
        assert!(decoded.height > 100);
    }

    #[test]
    fn raw_development_choices_change_sensor_decode() {
        let bytes = include_bytes!("../../../web/tests/fixtures/canon-a410-chdk.dng");
        let mut browser = BrowserEngine::new(
            include_bytes!("../../../data/profiles/kodak_portra_400.json"),
            include_bytes!("../../../data/profiles/kodak_portra_endura.json"),
            include_bytes!("../../../data/filters/neutral_print_filters.json"),
            include_bytes!("../../../data/luts/spectral_upsampling/irradiance_xy_tc.npy"),
            None,
        ).unwrap();
        browser.set_raw_development("uncorrected", "superpixel");
        assert!(!browser.raw_development.camera_white_balance);
        assert!(matches!(browser.raw_development.demosaic, RawDemosaic::Superpixel));
        browser.set_raw_development("camera", "ppg");
        assert!(browser.raw_development.camera_white_balance);
        assert!(matches!(browser.raw_development.demosaic, RawDemosaic::Ppg));
        let default = decode_raw_image(bytes, 0.1, RawDevelopment::default()).unwrap();
        let uncorrected = decode_raw_image(
            bytes,
            0.1,
            RawDevelopment { camera_white_balance: false, ..Default::default() },
        ).unwrap();
        let fast = decode_raw_image(
            bytes,
            0.1,
            RawDevelopment { demosaic: RawDemosaic::Superpixel, ..Default::default() },
        ).unwrap();
        assert_ne!(default.data, uncorrected.data);
        assert!(fast.width < default.width);
        assert!(fast.height < default.height);
    }

    #[test]
    fn downscaled_raw_export_uses_memory_bounded_demosaic() {
        let (development, scale) = bounded_raw_decode(RawDevelopment::default(), 0.5, 36_000_000);
        assert!(matches!(development.demosaic, RawDemosaic::Superpixel));
        assert_eq!(scale, 1.0);
        let (development, scale) = bounded_raw_decode(RawDevelopment::default(), 0.525, 36_000_000);
        assert!(matches!(development.demosaic, RawDemosaic::Ppg));
        assert_eq!(scale, 0.525);
        let (development, scale) = bounded_raw_decode(RawDevelopment::default(), 0.8, 36_000_000);
        assert!(matches!(development.demosaic, RawDemosaic::Ppg));
        assert_eq!(scale, 0.8);
        let (development, scale) = bounded_raw_decode(RawDevelopment::default(), 0.08, 7_000_000);
        assert!(matches!(development.demosaic, RawDemosaic::Ppg));
        assert_eq!(scale, 0.08);
    }

    #[test]
    fn dng_sensor_decode_applies_exif_orientation() {
        let mut bytes = include_bytes!("../../../web/tests/fixtures/canon-a410-chdk.dng").to_vec();
        set_tiff_orientation(&mut bytes, 6);
        let decoded = decode_raw_image(&bytes, 0.1, RawDevelopment::default()).unwrap();
        assert!(decoded.height > decoded.width);
    }

    #[test]
    fn raw_export_normalizes_applied_orientation_metadata() {
        use little_exif::exif_tag::ExifTag;

        let mut source = include_bytes!("../../../web/tests/fixtures/canon-a410-chdk.dng").to_vec();
        set_tiff_orientation(&mut source, 6);
        let jpeg = encode_rgb8_inner(1, 1, &[0, 0, 0], "jpeg", 95).unwrap();
        let output = preserve_metadata(&source, jpeg, "jpeg", 0, true).unwrap();
        let metadata = extract_ancillary_metadata(&output).exif.unwrap();
        assert_eq!(
            metadata
                .get_tag(&ExifTag::Orientation(Vec::new()))
                .next(),
            Some(&ExifTag::Orientation(vec![1]))
        );
    }

    fn set_tiff_orientation(bytes: &mut [u8], orientation: u16) {
        assert_eq!(&bytes[..2], b"II");
        let ifd = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let entries = u16::from_le_bytes(bytes[ifd..ifd + 2].try_into().unwrap()) as usize;
        let offset = (0..entries)
            .map(|entry| ifd + 2 + entry * 12)
            .find(|&offset| {
                u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap()) == 0x0112
            })
            .expect("fixture has no TIFF Orientation tag");
        bytes[offset + 8..offset + 10].copy_from_slice(&orientation.to_le_bytes());
    }

    #[test]
    fn settings_come_from_the_simulation_core() {
        let settings: serde_json::Value =
            serde_json::from_str(&default_settings_json().unwrap()).unwrap();
        assert_eq!(settings["io"]["input_color_space"], "sRGB");
        assert_eq!(settings["settings"]["preview_max_size"], 640);
        assert!(settings["camera"]["auto_exposure"].as_bool().unwrap());
        let mut imported = RuntimeParams::default();
        imported.io.input_color_space = "ProPhoto RGB".into();
        imported.io.input_cctf_decoding = true;
        let imported = browser_params(imported);
        assert_eq!(imported.io.input_color_space, "sRGB");
        assert!(!imported.io.input_cctf_decoding);
    }

    #[test]
    fn linear_raw_preview_is_encoded_for_an_srgb_jpeg() {
        assert!((raw_preview_channel(0.18) - 0.461_356_13).abs() < 1e-6);
        assert_eq!(raw_preview_channel(-1.0), 0.0);
        assert_eq!(raw_preview_channel(2.0), 1.0);
    }

    #[test]
    fn output_encoder_returns_file_bytes() {
        let pixels = [255, 0, 0, 0, 255, 0];
        for format in ["jpeg", "png", "tiff"] {
            let encoded = encode_rgb8_inner(2, 1, &pixels, format, 95).unwrap();
            let decoded = image::load_from_memory(&encoded).unwrap();
            assert_eq!(decoded.dimensions(), (2, 1));
        }
    }

    #[test]
    fn output_encoder_rejects_wrong_buffer_size() {
        let error = encode_rgb8_inner(2, 2, &[0; 3], "png", 95).unwrap_err();
        assert!(error.to_string().contains("expected 12 bytes"));
    }

    #[test]
    fn malformed_inputs_and_metadata_edge_cases_are_bounded() {
        use little_exif::{endian::Endian, exif_tag::ExifTag, metadata::Metadata};
        use rawler::{
            imgop::develop::Intermediate,
            pixarray::{Color2D, PixF32},
        };

        assert!(decode_standard_image(b"broken", 1.0, RawDevelopment::default()).is_err());
        assert_eq!(
            intermediate_rgb(Intermediate::Monochrome(PixF32::new_with(vec![-1.0], 1, 1))).1,
            vec![0.0; 3]
        );
        assert_eq!(
            intermediate_rgb(Intermediate::ThreeColor(Color2D::new_with(
                vec![[-1.0, 0.5, 1.0]],
                1,
                1
            )))
            .1,
            vec![0.0, 0.5, 1.0]
        );
        assert_eq!(
            intermediate_rgb(Intermediate::FourColor(Color2D::new_with(
                vec![[-1.0, 0.5, 1.0, 2.0]],
                1,
                1
            )))
            .1,
            vec![0.0, 0.5, 1.0]
        );
        assert!(encode_rgb8_inner(1, 1, &[0, 0, 0], "bad", 95).is_err());
        for format in ["jpeg", "png", "tiff"] {
            assert!(encode_rgb8_inner(0, 0, &[], format, 95).is_err());
        }
        let resized = resize_image_buf(ImageBuf::from_data(2, 2, vec![from_f32(0.5); 12]), 0.5);
        assert_eq!((resized.width, resized.height), (1, 1));
        assert_eq!(exif_words::<2>(&[1, 2], &Endian::Big).len(), 1);

        let image = ImageBuf::from_data(1, 1, vec![from_f32(0.5); 3]);
        assert!(encode_image_buf(&image, "bad", 95, &[], &AncillaryMetadata::default()).is_err());
        assert!(embed_icc(vec![], "jpeg", &[]).is_err());
        assert!(embed_icc(vec![], "png", &[]).is_err());
        assert_eq!(embed_icc(vec![1], "tiff", &[]).unwrap(), vec![1]);
        assert_eq!(encode_output_channel(0.001, "ProPhoto RGB", true), 0.016);
        assert!((encode_output_channel(0.001, "Rec. 2020", true) - 0.0045).abs() < 1e-6);

        assert!(
            extract_ancillary_metadata(&[0xff, 0xd8, 0xff, 0xe1, 0, 1])
                .jpeg_segments
                .is_empty()
        );
        let hostile_png = [
            137, 80, 78, 71, 13, 10, 26, 10, 0xff, 0xff, 0xff, 0xff, b'i', b'T', b'X', b't', 0, 0,
            0, 0,
        ];
        assert!(
            extract_ancillary_metadata(&hostile_png)
                .png_chunks
                .is_empty()
        );
        assert!(extract_ancillary_metadata(b"broken").exif.is_none());
        assert_eq!(jpeg_app_end(&[0xff, 0xd8, 0xff, 0xe1, 0, 1]), 2);
        assert_eq!(
            jpeg_for_exif(&[0xff, 0xd8, 0xff, 0xe1, 0, 1]),
            vec![0xff, 0xd8, 0xff, 0xe1, 0, 1]
        );
        assert_eq!(jpeg_for_exif(&[0xff, 0xd8]), vec![0xff, 0xd8]);

        let jpeg = encode_rgb8_inner(1, 1, &[0, 0, 0], "jpeg", 95).unwrap();
        assert_eq!(
            preserve_metadata(b"broken", jpeg.clone(), "jpeg", 0, false).unwrap(),
            jpeg
        );
        assert!(
            !preserve_metadata(&jpeg, jpeg.clone(), "jpeg", 0, false)
                .unwrap()
                .is_empty()
        );
        let mut rotated = AncillaryMetadata {
            exif: Some(Metadata::new()),
            ..Default::default()
        };
        rotate_metadata(&mut rotated, 1);
        assert_eq!(
            rotated
                .exif
                .as_ref()
                .unwrap()
                .get_tag(&ExifTag::Orientation(Vec::new()))
                .next(),
            Some(&ExifTag::Orientation(vec![6]))
        );
        normalize_metadata_orientation(&mut rotated);
        assert_eq!(
            rotated
                .exif
                .as_ref()
                .unwrap()
                .get_tag(&ExifTag::Orientation(Vec::new()))
                .next(),
            Some(&ExifTag::Orientation(vec![1]))
        );
        let mut mirrored = AncillaryMetadata {
            exif: Some(Metadata::new()),
            ..Default::default()
        };
        mirrored
            .exif
            .as_mut()
            .unwrap()
            .set_tag(ExifTag::Orientation(vec![5]));
        rotate_metadata(&mut mirrored, 1);
        assert_eq!(
            mirrored
                .exif
                .as_ref()
                .unwrap()
                .get_tag(&ExifTag::Orientation(Vec::new()))
                .next(),
            Some(&ExifTag::Orientation(vec![2]))
        );
        assert_eq!(orientation_value(&ExifTag::ImageWidth(vec![1])), None);

        let xmp = AncillaryMetadata {
            xmp: Some(b"xmp".to_vec()),
            ..Default::default()
        };
        assert!(
            embed_ancillary_metadata(jpeg.clone(), "jpeg", &xmp)
                .unwrap()
                .windows(3)
                .any(|bytes| bytes == b"xmp")
        );
        let png = encode_rgb8_inner(1, 1, &[0, 0, 0], "png", 95).unwrap();
        assert_eq!(
            extract_ancillary_metadata(&encode_rgb8_inner(1, 1, &[0, 0, 0], "tiff", 95).unwrap())
                .png_chunks,
            Vec::<Vec<u8>>::new()
        );
        assert!(
            embed_ancillary_metadata(png.clone(), "png", &xmp)
                .unwrap()
                .windows(3)
                .any(|bytes| bytes == b"xmp")
        );
        assert_eq!(
            embed_ancillary_metadata(png.clone(), "png", &AncillaryMetadata::default()).unwrap(),
            png
        );
        let existing_chunk = AncillaryMetadata {
            png_chunks: vec![vec![0, 0, 0, 0, b't', b'E', b'X', b't', 0, 0, 0, 0]],
            ..Default::default()
        };
        assert!(embed_ancillary_metadata(png.clone(), "png", &existing_chunk).is_ok());
        assert_eq!(
            embed_ancillary_metadata(vec![1], "tiff", &xmp).unwrap(),
            vec![1]
        );

        let mut generic = Metadata::new();
        generic.set_tag(ExifTag::ImageDescription("generic".into()));
        generic.set_tag(ExifTag::ImageWidth(vec![1]));
        generic.set_tag(ExifTag::UnknownINT8U(
            Vec::new(),
            0xc200,
            little_exif::ifd::ExifTagGroup::GENERIC,
        ));
        let generic = AncillaryMetadata {
            exif: Some(generic),
            ..Default::default()
        };
        assert!(
            !encode_image_buf(&image, "tiff", 95, &[], &generic)
                .unwrap()
                .is_empty()
        );
        let mut nested = Metadata::new();
        nested.set_tag(ExifTag::UnknownINT8U(
            vec![1],
            0xc201,
            little_exif::ifd::ExifTagGroup::EXIF,
        ));
        nested.set_tag(ExifTag::UnknownDOUBLE(
            vec![0.5],
            0xc202,
            little_exif::ifd::ExifTagGroup::INTEROP,
        ));
        assert!(
            !encode_image_buf(
                &image,
                "tiff",
                95,
                &[],
                &AncillaryMetadata {
                    exif: Some(nested),
                    ..Default::default()
                },
            )
            .unwrap()
            .is_empty()
        );
        let mut exif_only = Metadata::new();
        exif_only.set_tag(ExifTag::UnknownINT8U(
            vec![1],
            0xc203,
            little_exif::ifd::ExifTagGroup::EXIF,
        ));
        assert!(
            !encode_image_buf(
                &image,
                "tiff",
                95,
                &[],
                &AncillaryMetadata {
                    exif: Some(exif_only),
                    ..Default::default()
                },
            )
            .unwrap()
            .is_empty()
        );
        assert!(
            !encode_image_buf(
                &image,
                "tiff",
                95,
                &[],
                &AncillaryMetadata {
                    exif: Some(Metadata::new()),
                    ..Default::default()
                },
            )
            .unwrap()
            .is_empty()
        );
        let mut fake_exif = jpeg.clone();
        fake_exif.splice(2..2, [0xff, 0xe1, 0, 8, b'E', b'x', b'i', b'f', 0, 0]);
        assert_eq!(
            preserve_metadata(&fake_exif, jpeg.clone(), "jpeg", 0, false).unwrap(),
            jpeg
        );
        let empty = ImageBuf::from_data(0, 0, Vec::new());
        for format in ["jpeg", "png"] {
            assert!(
                encode_image_buf(&empty, format, 95, &[], &AncillaryMetadata::default()).is_err()
            );
        }
        assert_eq!(
            preserve_metadata(&jpeg, vec![1], "bad", 1, false).unwrap(),
            vec![1]
        );
    }

    #[test]
    fn output_transfer_curves_and_icc_tags_match() {
        assert!((encode_output_channel(0.5, "ACES2065-1", true) - 0.5).abs() < 1e-6);
        assert!(encode_output_channel(0.5, "ProPhoto RGB", true) > 0.67);
        assert!(encode_output_channel(0.5, "Rec. 2020", true) > 0.70);

        let image = ImageBuf::from_data(1, 1, vec![from_f32(0.5); 3]);
        let profile = icc::profile("ProPhoto RGB", true);
        let metadata = AncillaryMetadata {
            xmp: Some(b"<x:xmpmeta>kept</x:xmpmeta>".to_vec()),
            iptc: Some(b"iptc-kept".to_vec()),
            ..Default::default()
        };
        assert_eq!(
            u32::from_be_bytes(profile[..4].try_into().unwrap()) as usize,
            profile.len()
        );
        assert_eq!(&profile[36..40], b"acsp");
        for (space, encoded) in [
            ("ProPhoto RGB", false),
            ("Rec. 2020", true),
            ("Rec. 2020", false),
            ("ACES2065-1", true),
            ("sRGB", true),
            ("sRGB", false),
        ] {
            assert_eq!(&icc::profile(space, encoded)[36..40], b"acsp");
        }

        let jpeg = embed_icc(
            encode_image_buf(&image, "jpeg", 95, &profile, &metadata).unwrap(),
            "jpeg",
            &profile,
        )
        .unwrap();
        assert!(jpeg.windows(12).any(|bytes| bytes == b"ICC_PROFILE\0"));
        let png = embed_icc(
            encode_image_buf(&image, "png", 95, &profile, &metadata).unwrap(),
            "png",
            &profile,
        )
        .unwrap();
        assert!(png.windows(4).any(|bytes| bytes == b"iCCP"));
        let tiff = encode_image_buf(&image, "tiff", 95, &profile, &metadata).unwrap();
        let mut decoder = tiff::decoder::Decoder::new(Cursor::new(tiff)).unwrap();
        assert_eq!(
            decoder
                .get_tag_u8_vec(tiff::tags::Tag::Unknown(34675))
                .unwrap(),
            profile
        );
        assert_eq!(
            decoder
                .get_tag_u8_vec(tiff::tags::Tag::Unknown(700))
                .unwrap(),
            metadata.xmp.unwrap()
        );
        assert_eq!(
            decoder
                .get_tag_u8_vec(tiff::tags::Tag::Unknown(33723))
                .unwrap(),
            metadata.iptc.unwrap()
        );
    }

    #[test]
    fn complete_pipeline_calibrates_from_bytes() {
        let summary = calibrate_pipeline(
            include_bytes!("../../../data/profiles/kodak_portra_400.json"),
            include_bytes!("../../../data/profiles/kodak_portra_endura.json"),
            include_bytes!("../../../data/filters/neutral_print_filters.json"),
            include_bytes!("../../../data/luts/spectral_upsampling/irradiance_xy_tc.npy"),
            None,
        )
        .unwrap();
        let summary: serde_json::Value = serde_json::from_str(&summary).unwrap();
        assert_eq!(summary["film"], "kodak_portra_400");
        assert_eq!(summary["print"], "kodak_portra_endura");
        assert!(summary["spectralLutSize"].as_u64().unwrap() > 0);
    }

    #[test]
    fn reference_engine_processes_complete_pipeline() {
        let engine = BrowserEngine::new(
            include_bytes!("../../../data/profiles/kodak_portra_400.json"),
            include_bytes!("../../../data/profiles/kodak_portra_endura.json"),
            include_bytes!("../../../data/filters/neutral_print_filters.json"),
            include_bytes!("../../../data/luts/spectral_upsampling/irradiance_xy_tc.npy"),
            None,
        )
        .unwrap();
        let image = DynamicImage::ImageRgb8(ImageBuffer::from_pixel(2, 2, Rgb([128, 128, 128])));
        let mut input = Cursor::new(Vec::new());
        image.write_to(&mut input, ImageFormat::Png).unwrap();
        let output = engine
            .process_reference_inner(input.get_ref(), "tiff", 95, 1.0, 0)
            .unwrap();
        let decoded = image::load_from_memory(&output).unwrap();
        assert_eq!(decoded.dimensions(), (2, 2));
        assert!(matches!(decoded, DynamicImage::ImageRgb16(_)));
    }

    #[test]
    fn reference_export_preserves_photo_metadata() {
        use little_exif::{
            exif_tag::ExifTag, filetype::FileExtension, ifd::ExifTagGroup, metadata::Metadata,
        };

        let engine = BrowserEngine::new(
            include_bytes!("../../../data/profiles/kodak_portra_400.json"),
            include_bytes!("../../../data/profiles/kodak_portra_endura.json"),
            include_bytes!("../../../data/filters/neutral_print_filters.json"),
            include_bytes!("../../../data/luts/spectral_upsampling/irradiance_xy_tc.npy"),
            None,
        )
        .unwrap();
        let image = DynamicImage::ImageRgb8(ImageBuffer::from_pixel(2, 2, Rgb([128, 128, 128])));
        let mut input = Cursor::new(Vec::new());
        image.write_to(&mut input, ImageFormat::Jpeg).unwrap();
        let mut source = input.into_inner();
        let mut metadata = Metadata::new();
        metadata.set_tag(ExifTag::ImageDescription("kept by Spektra".into()));
        metadata.set_tag(ExifTag::GPSLatitudeRef("N".into()));
        metadata.set_tag(ExifTag::GPSLatitude(vec![
            22u32.into(),
            18u32.into(),
            0u32.into(),
        ]));
        metadata.set_tag(ExifTag::GPSLongitudeRef("E".into()));
        metadata.set_tag(ExifTag::GPSLongitude(vec![
            114u32.into(),
            10u32.into(),
            0u32.into(),
        ]));
        for tag in [
            ExifTag::UnknownINT8U(vec![1], 0xc100, ExifTagGroup::EXIF),
            ExifTag::UnknownSTRING("all formats".into(), 0xc101, ExifTagGroup::EXIF),
            ExifTag::UnknownINT16U(vec![2], 0xc102, ExifTagGroup::EXIF),
            ExifTag::UnknownINT32U(vec![3], 0xc103, ExifTagGroup::EXIF),
            ExifTag::UnknownRATIONAL64U(vec![4u32.into()], 0xc104, ExifTagGroup::EXIF),
            ExifTag::UnknownINT8S(vec![-1], 0xc105, ExifTagGroup::EXIF),
            ExifTag::UnknownUNDEF(vec![5], 0xc106, ExifTagGroup::EXIF),
            ExifTag::UnknownINT16S(vec![-2], 0xc107, ExifTagGroup::EXIF),
            ExifTag::UnknownINT32S(vec![-3], 0xc108, ExifTagGroup::EXIF),
            ExifTag::UnknownRATIONAL64S(vec![(-4i32).into()], 0xc109, ExifTagGroup::EXIF),
            ExifTag::UnknownFLOAT(vec![0.5], 0xc10a, ExifTagGroup::EXIF),
            ExifTag::UnknownDOUBLE(vec![0.25], 0xc10b, ExifTagGroup::INTEROP),
        ] {
            metadata.set_tag(tag);
        }
        metadata
            .write_to_vec(&mut source, FileExtension::JPEG)
            .unwrap();
        let xmp = b"<x:xmpmeta>Spektra XMP</x:xmpmeta>";
        let xmp_payload = [b"http://ns.adobe.com/xap/1.0/\0".as_slice(), xmp].concat();
        let mut xmp_segment = vec![0xff, 0xe1];
        xmp_segment.extend_from_slice(&((xmp_payload.len() + 2) as u16).to_be_bytes());
        xmp_segment.extend_from_slice(&xmp_payload);
        let app13_payload = b"Photoshop 3.0\0IPTC kept";
        let mut app13 = vec![0xff, 0xed];
        app13.extend_from_slice(&((app13_payload.len() + 2) as u16).to_be_bytes());
        app13.extend_from_slice(app13_payload);
        source.splice(2..2, [xmp_segment, app13].concat());

        let output = engine
            .process_reference_inner(&source, "jpeg", 95, 1.0, 0)
            .unwrap();
        let copied = Metadata::new_from_vec(&output, FileExtension::JPEG).unwrap();
        assert_eq!(
            copied
                .get_tag(&ExifTag::ImageDescription(String::new()))
                .next(),
            Some(&ExifTag::ImageDescription("kept by Spektra".into()))
        );
        assert!(
            copied
                .get_tag(&ExifTag::GPSLatitude(Vec::new()))
                .next()
                .is_some()
        );
        let ancillary = extract_ancillary_metadata(&output);
        assert_eq!(ancillary.xmp.as_deref(), Some(xmp.as_slice()));
        assert!(
            ancillary
                .jpeg_segments
                .iter()
                .any(|segment| segment.windows(9).any(|bytes| bytes == b"IPTC kept"))
        );
        assert!(output.windows(12).any(|bytes| bytes == b"ICC_PROFILE\0"));
        assert!(
            copied
                .get_tag(&ExifTag::GPSLongitude(Vec::new()))
                .next()
                .is_some()
        );
        let rotated = engine
            .process_reference_inner(&source, "jpeg", 95, 1.0, 1)
            .unwrap();
        let rotated = Metadata::new_from_vec(&rotated, FileExtension::JPEG).unwrap();
        assert_eq!(
            rotated.get_tag(&ExifTag::Orientation(Vec::new())).next(),
            Some(&ExifTag::Orientation(vec![6]))
        );

        for (format, file_type) in [
            (
                "png",
                FileExtension::PNG {
                    as_zTXt_chunk: true,
                },
            ),
            ("tiff", FileExtension::TIFF),
        ] {
            let output = engine
                .process_reference_inner(&source, format, 95, 1.0, 0)
                .unwrap();
            let copied = Metadata::new_from_vec(&output, file_type).unwrap();
            assert_eq!(
                copied
                    .get_tag(&ExifTag::ImageDescription(String::new()))
                    .next(),
                Some(&ExifTag::ImageDescription("kept by Spektra".into()))
            );
            assert!(
                copied
                    .get_tag(&ExifTag::GPSLatitude(Vec::new()))
                    .next()
                    .is_some()
            );
            assert!(
                copied
                    .get_tag(&ExifTag::GPSLongitude(Vec::new()))
                    .next()
                    .is_some()
            );
            let ancillary = extract_ancillary_metadata(&output);
            assert_eq!(ancillary.xmp.as_deref(), Some(xmp.as_slice()));
            assert!(if format == "png" {
                output.windows(4).any(|bytes| bytes == b"iCCP")
            } else {
                output.windows(4).any(|bytes| bytes == b"acsp")
            });
        }
    }

    #[test]
    fn jpeg_metadata_drops_raw_payloads_but_keeps_portable_exif() {
        use little_exif::{exif_tag::ExifTag, ifd::ExifTagGroup, metadata::Metadata};

        let mut source = Metadata::new();
        source.set_tag(ExifTag::ImageDescription("kept".into()));
        source.set_tag(ExifTag::UnknownUNDEF(vec![7; 70_000], 0xc634, ExifTagGroup::GENERIC));
        let portable = portable_metadata(&source);
        assert_eq!(
            portable.get_tag(&ExifTag::ImageDescription(String::new())).next(),
            Some(&ExifTag::ImageDescription("kept".into()))
        );
        assert!(portable.get_tag_by_hex(0xc634, None).next().is_none());
    }
}

#[cfg(all(test, target_arch = "wasm32"))]
mod browser_tests {
    use super::*;
    use image::{DynamicImage, ImageBuffer, ImageFormat, Rgb};
    use spektrafilm_math::precision::from_f64;
    use std::io::Cursor;
    use wasm_bindgen_test::*;

    wasm_bindgen_test_configure!(run_in_browser);

    fn engine(settings: Option<String>) -> BrowserEngine {
        BrowserEngine::new(
            include_bytes!("../../../data/profiles/kodak_portra_400.json"),
            include_bytes!("../../../data/profiles/kodak_portra_endura.json"),
            include_bytes!("../../../data/filters/neutral_print_filters.json"),
            include_bytes!("../../../data/luts/spectral_upsampling/irradiance_xy_tc.npy"),
            settings,
        )
        .unwrap()
    }

    #[wasm_bindgen_test]
    fn portable_device_limits() {
        let inspection = inspect_dimensions(6000, 4000, DeviceLimits::default()).unwrap();
        assert_eq!(inspection.estimated_working_bytes, 1_920_000_000);
        assert!(inspection.requires_resize);
        assert!(inspection.tile_rows < inspection.height);
        assert_eq!(MAX_STORAGE_BINDING_BYTES, 128 * 1024 * 1024);
        assert_eq!(MAX_WORKGROUP_INVOCATIONS, 256);
    }

    #[wasm_bindgen_test]
    fn reference_full_pipeline_parity() {
        let mut params = RuntimeParams::default();
        params.camera.auto_exposure = false;
        params.io.input_color_space = "sRGB".into();
        params.io.input_cctf_decoding = false;
        params.io.output_cctf_encoding = false;
        params.film_render.grain.active = false;
        params.film_render.halation.active = false;
        params.film_render.dir_couplers.active = false;
        params.print_render.glare.active = false;
        params.scanner.unsharp_mask = [0.0, 0.0];
        let engine = engine(Some(serde_json::to_string(&params).unwrap()));
        let output = engine.pipeline.process(
            ImageBuf::from_data(1, 1, vec![from_f64(0.184); 3]),
            &CpuBackend,
        );
        let expected = [
            0.17518024973220059,
            0.17883059767931708,
            0.18934288118407094,
        ];
        for (actual, expected) in output.get(0, 0).iter().zip(expected) {
            assert!((*actual as f64 - expected).abs() < 1e-6);
        }
    }

    #[wasm_bindgen_test(async)]
    async fn browser_full_pipeline_modes() {
        let mut engine = engine(None);
        engine.enable_gpu().await.unwrap();
        let image = DynamicImage::ImageRgb8(ImageBuffer::from_pixel(2, 2, Rgb([128, 96, 64])));
        let mut input = Cursor::new(Vec::new());
        image.write_to(&mut input, ImageFormat::Png).unwrap();

        let reference = engine
            .process_reference(input.get_ref(), "png", 95, 1.0)
            .unwrap();
        let fast = engine
            .process_fast(input.get_ref(), "png", 95, 1.0, true)
            .await
            .unwrap();
        assert_eq!(
            image::load_from_memory(&reference).unwrap().dimensions(),
            (2, 2)
        );
        assert_eq!(image::load_from_memory(&fast).unwrap().dimensions(), (2, 2));
    }
}
