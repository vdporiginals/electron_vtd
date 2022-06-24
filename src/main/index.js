// @flow
import * as remote from "@electron/remote/main";
import childProcess from "child_process";
import debug from "debug";
import { app, BrowserWindow, ipcMain, Menu, Tray } from "electron";
import settings from "electron-settings";
import express from "express";
import { promises as fsPromises } from "fs";
import https from "https";
import os from "os";
import * as path from "path";
import tmp from "tmp";
import { format as formatUrl } from "url";
import packageJson from "../../package.json";
import { Blob } from "buffer";

remote.initialize();

const d = debug("electron-print-server");

const isDevelopment = process.env.NODE_ENV !== "production";

// global reference to mainWindow (necessary to prevent window from being
// garbage collected)
let mainWindow, tray;

function createMainWindow() {
  const win = new BrowserWindow({
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    show: false,
    title: "VTD-ERP Print server (version " + packageJson.version + ")",
  });

  if (isDevelopment) {
    win.webContents.openDevTools();
  }

  remote.enable(win.webContents);

  if (isDevelopment) {
    win.loadURL(`http://localhost:${process.env.ELECTRON_WEBPACK_WDS_PORT}`);
  } else {
    win.loadURL(
      formatUrl({
        pathname: path.join(__dirname, "index.html"),
        protocol: "file",
        slashes: true,
      })
    );
  }

  win.on("closed", () => {
    mainWindow = null;
  });

  win.webContents.on("devtools-opened", () => {
    win.focus();
    setImmediate(() => {
      win.focus();
    });
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  return win;
}

function createTray() {
  const t = new Tray(trayIconPath());

  const menu = Menu.buildFromTemplate([
    {
      type: "normal",
      label: "Mở",
      click: toggleMainWindow,
    },
    {
      type: "separator",
    },
    {
      type: "normal",
      label: "Thoát",
      click: quit,
    },
  ]);

  t.on("click", toggleMainWindow);

  // t.setToolTip('Сервер печати');
  t.setContextMenu(menu);

  return t;
}

function toggleMainWindow() {
  if (mainWindow) {
    // TODO: Hide instead?
    // TODO: Recreating is slow, but it's a rare case.
    mainWindow.hide();
    mainWindow = null;
  } else {
    mainWindow = createMainWindow();
  }
}

// Override default behavior: we don't want to quit when window is closed.
app.on("window-all-closed", () => {});

app.on("activate", () => {
  // on macOS it is common to re-create a window even after all windows have
  // been closed
  if (mainWindow === null) {
    mainWindow = createMainWindow();
  }
});

// create main BrowserWindow when electron is ready
app.on("ready", () => {
  const shouldShowWindow = !process.argv.includes("--silent");

  if (shouldShowWindow) {
    mainWindow = createMainWindow();
  }

  tray = createTray();
  app.setLoginItemSettings({
    openAtLogin: true,
    path: app.getPath("exe"),
  });
  const address = settings.getSync("server.ip") || "localhost";
  const port = settings.getSync("server.port") || "3179";
  if (address && port) {
    startServer(address, port, {
      useHttps: false,
      httpsCert: "",
      httpsCertKey: "",
    });
  }
});

/**
 * @type {Express}
 */
const expressApp = express();
let appListener;
/**
 * @type {Set<Socket>}
 */
const sockets = new Set();
/**
 * @type Electron.WebContents
 */
let webContents;

expressApp.use(function (req, res, next) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", ["Content-Type"].join(","));
  next();
});
expressApp.use(express.json()); // Used to parse JSON bodies
expressApp.use(express.urlencoded()); //Parse URL-encoded bodies
let multer = require("multer");
let upload = multer();

expressApp.get("/printers", (req, res) => {
  res.json(webContents ? webContents.getPrinters() : null);
});

expressApp.post("/print", upload.fields(['session_id', 'jobs']), (req, res) => {
  const jobs = JSON.parse(req.body.jobs);
  const session = req.body.session_id;
  // d("Printing %d session",  req.body);
  // d("Printing %d jobs", jobs.length);
  // console.log('body', req.body.session_id );
  // console.log('filés', req.files );
  // console.log("Printing session", req.body);
  // console.log("Printing %d jobs", jobs.length);
  // console.log("job.url", jobs[0].url);
  Promise.all(
    jobs.map((job) => {
      return printUrl(job.url, job.printer, job.settings, session).then(
        (r) => {
          console.log(r);
          console.log(new Date().getTime());
          return true;
        },
        (e) => {
          console.log(e);
          return false;
        }
      );
    })
  ).then((results) => {
    console.log(results);
    console.log(new Date().getTime());
    res.json(results);
  });
  return res.sendStatus(200);
});
ipcMain.on("get-printers", (e) => {
  webContents = e.sender;
  e.returnValue = webContents.getPrinters();
});

ipcMain.on("print", ({ sender }, { url, printer, settings }) => {
  webContents = sender;
  // console.log(new Date().getTime());
  printUrl(url, printer, settings).then(
    () => {
      // console.log(new Date().getTime());
      webContents.send("print-result", { success: true });
    },
    (error) => {
      webContents.send("print-result", { success: false, error });
    }
  );
});

ipcMain.on("get-network-interfaces", (e) => {
  webContents = e.sender;
  e.returnValue = os.networkInterfaces();
});

ipcMain.on("start-server", ({ sender }, { hostname, port, httpsSettings }) => {
  webContents = sender;
  startServer(hostname, port, httpsSettings).then(() => {
    webContents.send("server-state", "running");
  });
});

ipcMain.on("stop-server", ({ sender }) => {
  d("Stopping server...");
  webContents = sender;
  if (!appListener) {
    d("Server is not started");
    webContents.send("server-state", "stopped");
    // tray.setToolTip('Сервер печати - Остановлен');
    return;
  }
  sockets.forEach((socket) => {
    socket.destroy();
  });
  appListener.close(() => {
    d("Server stopped");
    webContents.send("server-state", "stopped");
    // tray.setToolTip('Сервер печати - Остановлен');
    appListener = null;
  });
});

ipcMain.on("get-server-state", (e) => {
  webContents = e.sender;
  if (appListener) {
    webContents.send("server-state", "running");
  } else {
    webContents.send("server-state", "stopped");
  }
});

function startServer(hostname, port, { useHttps, httpsCert, httpsCertKey }) {
  d("Starting server... (use HTTPS: %j)", useHttps);
  return new Promise((resolve) => {
    if (useHttps) {
      appListener = https
        .createServer(
          {
            cert: httpsCert,
            key: httpsCertKey,
          },
          expressApp
        )
        .listen(port, hostname, listenHandler);
    } else {
      appListener = expressApp.listen(port, hostname, listenHandler);
    }

    appListener.on("connection", (socket) => {
      sockets.add(socket);
      d("New connection; total length = %d", sockets.size);
      socket.on("close", () => {
        sockets.delete(socket);
        d("Connection closed; total length = %d", sockets.size);
      });
    });

    function listenHandler() {
      const addr = appListener.address();
      d("Server started on %o", addr);
      // tray.setToolTip(`Сервер печати - Запущен на ${addr.address}:${addr.port}`);
      resolve();
    }
  });
}

async function printUrl(url, printer, printSettings, session) {
  // d("Loading url %s", session);
  // console.log(session);
  // var arrByte = Uint8Array.from(await session.arrayBuffer())
  // console.log(session)
  // var blob = new Blob([session], { type: "application/pdf" });
  console.log(new Date().getTime())
  return Promise.resolve(session)
    .then(
      async (r) => {
        // const { type } = contentType.parse(r.headers['content-type']);

        if (r) {
          
          // d('Content type is %s, printing directly', type);
          return Promise.resolve(Buffer.from(r, 'base64'));
        }

        // d('Content type is %s, converting to PDF', type);

        const w = new BrowserWindow({
          show: false,
        });

        return w
          .loadURL(url, {
            userAgent: "ElectronPrintServer / " + packageJson.version,
          })
          .then(() => {
            return w.webContents.printToPDF({});
          })
          .catch((e) => {
            d("Convert to PDF error: %s", e.message);
            throw e;
          })
          .finally(() => {
            w.close();
          });
      },
      (e) => {
        // d("Error loading URL:", e.message);

        // if (e.response) {
        //   d("Raw response:", e.response.data.toString());
        // }

        throw e;
      }
    )
    .then(async (data) => {
      const fileName = tmp.fileSync({
        prefix: "print_",
        postfix: ".pdf",
      }).name;
      // var binary_string = atob(data);
      // var len = binary_string.length;
      // var bytes = new Uint8Array(len);
      // for (var i = 0; i < len; i++) {
      //     bytes[i] = binary_string.charCodeAt(i);
      // }
    // return bytes.buffer;
      return fsPromises.writeFile(fileName, data).then(
        () => {
          // console.log(new Date().getTime());
          return fileName;
        },
        (e) => {
          d("PDF write error: %s", e.message);
          throw e;
        }
      );
    })
    .then((fileName) => {
      return printFile(fileName, printer, printSettings).catch((e) => {
        d("Print error: %s", e.message);
        throw e;
      });
    });
}

function printFile(fileName, printer, printSettings) {
  return new Promise((resolve, reject) => {
    let command;
    const printerEscaped = printer.replace('"', '\\"');
    const fileNameEscaped = fileName.replace('"', '\\"');

    // console.log(printerEscaped, printer, fileNameEscaped, fileName);
    // Not supporting other platforms
    // noinspection SwitchStatementWithNoDefaultBranchJS
    // console.log('onPrint file', fileNameEscaped, printerEscaped, printSettings, process.platform)
    switch (process.platform) {
      case "darwin":
      case "linux":
        command = [
          "lp",
          printSettingsToLpFormat(printSettings),
          `-d "${printerEscaped}"`,
          fileNameEscaped,
        ].join(" ");
        break;
      case "win32":
        command = [
          `"${extraResourcePath(
            process.platform,
            process.arch,
            "SumatraPDF.exe"
          )}"`,
          `-print-to "${printerEscaped}"`,
          `-print-settings "${printSettingsToSumatraFormat(printSettings)}"`,
          "-silent",
          `"${fileNameEscaped}"`,
        ].join(" ");
        break;
    }
    d(`Executing: ${command}`);
    childProcess.exec(command, {}, (err, stdout) => {
      if (err) {
        d("Shell exec error: %s", err.message);
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

function printSettingsToLpFormat(printSettings) {
  if (!printSettings) {
    return "";
  }
  const parts = [];
  if (printSettings.duplex) {
    parts.push(
      "-o sides=" +
        {
          simplex: "one-sided",
          short: "two-sided-short-edge",
          long: "two-sided-long-edge",
        }[printSettings.duplex]
    );
  }

  if (printSettings.copies && printSettings.copies > 1) {
    parts.push("-n " + printSettings.copies);
  }

  if (printSettings.orientation) {
    parts.push(printSettings.orientation);
    parts.push(
      "-o orientation-requested=" +
        {
          portrait: 3,
          landscape: 4,
        }[printSettings.orientation]
    );
  }

  return parts.join(" ");
}

function printSettingsToSumatraFormat(printSettings) {
  if (!printSettings) {
    return "";
  }
  const parts = [];
  if (printSettings.duplex) {
    parts.push(
      {
        simplex: "simplex",
        short: "duplexshort",
        long: "duplexlong",
      }[printSettings.duplex]
    );
  }

  if (printSettings.copies && printSettings.copies > 1) {
    parts.push(printSettings.copies + "x");
  }

  if (printSettings.orientation) {
    parts.push(printSettings.orientation);
  }

  return parts.join(",");
}

function extraResourcePath(...p) {
  if (isDevelopment) {
    return path.resolve(__dirname, "../../external", ...p);
  } else {
    return path.join(process.resourcesPath, "external", ...p);
  }
}

function trayIconPath() {
  switch (process.platform) {
    case "linux":
      return path.join(__static, "/icons/linux/tray-icon.png");
    case "win32":
      return path.join(__static, "/icons/win32/tray-icon.ico");
    default:
      return null;
  }
}

function quit() {
  if (appListener) {
    sockets.forEach((socket) => {
      socket.destroy();
    });
    appListener.close(() => {
      app.quit();
    });
  } else {
    app.quit();
  }
}
