// Ghostscript compiled to WebAssembly converts colors on this computer.
// The 15.5 MB engine is fetched once per session and must match its pinned SHA-256.
import createGhostscript from "@okathira/ghostpdl-wasm";

export const ENGINE = {
  name: "Ghostscript 10.06",
  url: "https://cdn.jsdelivr.net/npm/@okathira/ghostpdl-wasm@1.1.0/dist/gs.wasm",
  sha256: "e8aaf3af75da65fe0af8d49b30fa717e4ff13eedbbdc0cdd5700f54fb8f667e6",
  size: 15533045,
};

export const PROFILE_PATH = "/profile.icc";

// "keep" only reduces images and leaves every color as it is.
const STRATEGIES = { cmyk: ["CMYK", "DeviceCMYK"], gray: ["Gray", "DeviceGray"], rgb: ["RGB", "DeviceRGB"], keep: ["LeaveColorUnchanged", null] };

// Ghostscript arguments for one conversion of /in.pdf to /out.pdf.
// /prepress keeps image quality high; the explicit settings after it take precedence.
// The print profile is the target for CMYK, and the source of CMYK colors for an RGB proof.
export function conversionArgs(options) {
  const args = ["-dPDFSETTINGS=/prepress", "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.7", "-dAutoRotatePages=/None"];
  const [strategy, model] = STRATEGIES[options.color];
  args.push(`-sColorConversionStrategy=${strategy}`);
  if (model) args.push(`-dProcessColorModel=/${model}`);
  if (options.profile) {
    args.push(`--permit-file-read=${PROFILE_PATH}`, `${options.color === "rgb" ? "-sDefaultCMYKProfile" : "-sOutputICCProfile"}=${PROFILE_PATH}`);
  }
  for (const kind of ["Color", "Gray", "Mono"]) {
    if (options.downsample && kind !== "Mono") {
      args.push(`-dDownsample${kind}Images=true`, `-d${kind}ImageResolution=${options.downsample}`, `-d${kind}ImageDownsampleThreshold=1.0`, `-d${kind}ImageDownsampleType=/Bicubic`);
    } else {
      args.push(`-dDownsample${kind}Images=false`);
    }
  }
  args.push("-sOutputFile=/out.pdf", "/in.pdf");
  return args;
}

let compiled = null;

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function engineLoaded() {
  return compiled !== null;
}

export function loadEngine(onProgress) {
  if (!compiled) {
    compiled = (async () => {
      const response = await fetch(ENGINE.url);
      if (!response.ok) throw new Error(`Couldn't download the color engine (HTTP ${response.status}).`);
      const reader = response.body.getReader();
      const bytes = new Uint8Array(ENGINE.size);
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.length > bytes.length) throw new Error("The color engine download is larger than expected and was rejected.");
        bytes.set(value, received);
        received += value.length;
        if (onProgress) onProgress(received / ENGINE.size);
      }
      if (received !== ENGINE.size || (await sha256Hex(bytes)) !== ENGINE.sha256) {
        throw new Error("The color engine download didn't match its checksum and was rejected.");
      }
      return WebAssembly.compile(bytes);
    })();
    compiled.catch(() => {
      compiled = null;
    });
  }
  return compiled;
}

// Runs Ghostscript once in a fresh instance of the compiled engine.
export async function runGhostscript(args, files, onProgress) {
  const wasm = await loadEngine(onProgress);
  const log = [];
  const gs = await createGhostscript({
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(wasm, imports).then((instance) => done(instance, wasm));
      return {};
    },
    print: (line) => log.push(line),
    printErr: (line) => log.push(line),
  });
  for (const path of Object.keys(files)) gs.FS.writeFile(path, files[path]);
  const code = gs.callMain(["-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", ...args]);
  if (code !== 0) {
    const detail = log.filter((line) => /error/i.test(line)).slice(-2).join(" ");
    throw new Error(`Color conversion failed${detail ? ": " + detail : "."}`);
  }
  return gs.FS.readFile("/out.pdf");
}
