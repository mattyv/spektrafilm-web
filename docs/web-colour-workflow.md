# Web colour workflow

SpektraFilm models scene light passing through film, print paper, and a scanner. It expects scene-referred, linear RGB values with correctly declared primaries. The web app owns RAW development, transfer-function decoding, display encoding, ICC tagging, and file I/O.

## Recommended use

1. Open a camera RAW file when possible. JPEG, PNG, and ordinary TIFF files already contain a camera or editor rendering, so the simulation is less physically faithful.
2. Start with **Camera As Shot** white balance. Use the eyedropper or temperature and tint controls if a neutral object is available.
3. Use **PPG quality** for final output. On phones, the interactive preview uses the lower-memory half-size sensor demosaic; export still uses the selected demosaic method.
4. Keep automatic exposure on initially, then use exposure compensation to choose how the virtual negative is exposed.
5. Pair a negative film with its intended print stock before judging colour. **None — scan film directly** is a different physical output, not a neutral version of a print.
6. Export JPEG or PNG as sRGB for ordinary screens and sharing. Use 16-bit TIFF with ProPhoto RGB, Rec. 2020, or ACES only for a colour-managed workflow.

## Browser pipeline

| Stage | Contract |
| --- | --- |
| Standard image decode | Assume encoded sRGB, decode its transfer curve, then supply linear sRGB to the simulator. |
| RAW decode | Apply black and white levels, demosaic, crop, camera white balance, and the camera matrix; output linear sRGB. |
| Simulation | Linear sRGB → film → optional print → scan. |
| Preview | Process a reduced image with Fast GPU and encode it for browser display. |
| Reference export | Process the source locally with the f64 CPU path, then encode and tag the selected output colour space. |

The browser adapter always declares linear sRGB input because both of its current decoders produce linear sRGB. Imported recipes cannot override that decoder contract.

## Audit against the reference implementation

The following items now match the documented reference contract:

- the simulation receives linear pixels with matching primaries;
- RAW and standard-image input do not receive a second transfer-function decode;
- sensor-linear RAW previews receive an sRGB display encoding before JPEG storage;
- phone previews use sensor data with a bounded half-size demosaic instead of a baked camera thumbnail;
- output transfer functions and ICC profiles match the selected output colour space;
- RAW auto-orientation and exported orientation metadata are normalized;
- RAW processing does not apply an automatic brightness lift before the simulation.

Known limits:

- the browser assumes sRGB for standard images and does not yet transform arbitrary embedded input ICC profiles;
- the RAW UI currently exposes as-shot and uncorrected white balance, while the Python reference also offers daylight, tungsten, and custom chromatic adaptation;
- Rawler uses a camera colour matrix but does not implement the reference importer’s LibRaw-to-linear-ACES route or the complete DNG profile pipeline, including every ForwardMatrix, HueSatMap, and baseline-exposure behavior;
- half-size phone previews trade fine demosaic detail for memory safety; full export uses the selected method;
- spectral reconstruction of skin is an active upstream research area, so correctly prepared input can still show stock-dependent skin hue shifts.

## Sources

- [SpektraFilm reference documentation](https://github.com/andreavolpato/spektrafilm#readme)
- [Reference RAW processor](https://github.com/andreavolpato/spektrafilm/blob/main/src/spektrafilm/utils/raw_file_processor.py)
- [RawPy processing parameters](https://letmaik.github.io/rawpy/api/rawpy.Params.html)
- [SpektraFilm technical discussion on skin spectra](https://discuss.pixls.us/t/spektrafilm-tech-discussions/57512)
- [Adobe Digital Negative specification](https://helpx.adobe.com/camera-raw/digital-negative.html)
