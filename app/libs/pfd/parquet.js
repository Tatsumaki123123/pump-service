"use strict";

/**
 * parquet 读取封装。
 *
 * hyparquet 只提供 ESM 入口，本项目是 CommonJS（egg），
 * 所以用动态 import() 懒加载并缓存模块本身。
 *
 * 出于内存考虑按 rowStart/rowEnd 分块读取，避免一次性把整小时
 * 几十万行 swap 全部物化成对象数组。
 */

let libPromise = null;

async function loadLib() {
  if (!libPromise) {
    libPromise = (async () => {
      const hyparquet = await import("hyparquet");
      let compressors;
      try {
        const mod = await import("hyparquet-compressors");
        compressors = mod.compressors;
      } catch (error) {
        // 只有 SNAPPY / UNCOMPRESSED 能原生解压，其余编码会抛错，
        // 这里不阻断启动，交由具体文件的解析错误暴露问题。
        compressors = undefined;
      }
      return { hyparquet, compressors };
    })();
  }
  return libPromise;
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
}

// parquetSchema 返回的是 schema 树根节点，这里只取顶层列名（数据源是扁平结构）
function topLevelColumns(hyparquet, metadata) {
  try {
    const root = hyparquet.parquetSchema(metadata);
    const children = (root && root.children) || [];
    return children.map((child) => child.element && child.element.name).filter(Boolean);
  } catch (error) {
    return [];
  }
}

async function readMetadata(buffer) {
  const { hyparquet } = await loadLib();
  const metadata = hyparquet.parquetMetadata(toArrayBuffer(buffer));
  return {
    numRows: Number(metadata.num_rows || 0),
    columns: topLevelColumns(hyparquet, metadata),
    codecs: (
      (metadata.row_groups && metadata.row_groups[0] && metadata.row_groups[0].columns) ||
      []
    )
      .map((column) => column.meta_data && column.meta_data.codec)
      .filter(Boolean),
    metadata,
  };
}

/**
 * 分块读取 parquet，按块把行数组交给 handler。
 * @param {Buffer} buffer
 * @param {string[]} columns 只读取需要的列，能显著省内存
 * @param {(rows: object[]) => (void|Promise<void>)} handler
 */
async function readRows(buffer, columns, handler, options = {}) {
  const { hyparquet, compressors } = await loadLib();
  const file = toArrayBuffer(buffer);
  const metadata = hyparquet.parquetMetadata(file);
  const numRows = Number(metadata.num_rows || 0);
  const chunkSize = Math.max(1000, Number(options.chunkSize) || 100000);
  const present = new Set(topLevelColumns(hyparquet, metadata));
  const wanted = columns && columns.length ? columns.filter((c) => present.has(c)) : undefined;

  let emitted = 0;
  for (let start = 0; start < numRows; start += chunkSize) {
    const end = Math.min(start + chunkSize, numRows);
    const rows = await hyparquet.parquetReadObjects({
      file,
      columns: wanted,
      rowStart: start,
      rowEnd: end,
      compressors,
      rowFormat: "object",
    });
    if (rows && rows.length) {
      emitted += rows.length;
      await handler(rows);
    }
  }

  return { numRows, emitted, columns: wanted || [...present] };
}

module.exports = { readRows, readMetadata, toArrayBuffer };
