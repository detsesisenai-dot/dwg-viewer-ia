// Web Worker: decodifica DWG/DXF com LibreDWG (WebAssembly) fora da thread de UI.
import { Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web';

let libPromise = null;

function getLib() {
  // O Vite empacota o libredwg-web.wasm em /assets (nome com hash) automaticamente.
  if (!libPromise) libPromise = LibreDwg.create();
  return libPromise;
}

self.onmessage = async (event) => {
  const { id, buffer, fileName } = event.data;
  try {
    self.postMessage({ id, status: 'Carregando motor LibreDWG (WebAssembly)…' });
    const lib = await getLib();

    const isDxf = /\.dxf$/i.test(fileName);
    self.postMessage({ id, status: `Decodificando ${isDxf ? 'DXF' : 'DWG'}…` });

    const fileType = isDxf ? Dwg_File_Type.DXF : Dwg_File_Type.DWG;
    const dwg = lib.dwg_read_data(buffer, fileType);
    if (dwg == null) throw new Error('Não foi possível ler o arquivo (formato inválido ou versão não suportada).');

    self.postMessage({ id, status: 'Convertendo entidades…' });
    const db = lib.convert(dwg);
    lib.dwg_free(dwg);

    // Remove dados binários desnecessários antes de transferir para a UI.
    delete db.thumbnailImage;
    self.postMessage({ id, db });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
