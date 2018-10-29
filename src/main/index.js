import bodyParser from 'body-parser';
import childProcess from 'child_process';
import debug from 'debug';
import { app, BrowserWindow, ipcMain, Menu, Tray } from 'electron';
import settings from 'electron-settings';
import express from 'express';
import fs from 'fs';
import os from 'os';
import * as path from 'path';
import tmp from 'tmp';
import { format as formatUrl } from 'url';

const d = debug('electron-print-server');

const isDevelopment = process.env.NODE_ENV !== 'production';

// global reference to mainWindow (necessary to prevent window from being
// garbage collected)
let mainWindow, tray;

function createMainWindow() {
    const win = new BrowserWindow({ show: false });

    if (isDevelopment) {
        win.webContents.openDevTools();
    }

    if (isDevelopment) {
        win.loadURL(`http://localhost:${process.env.ELECTRON_WEBPACK_WDS_PORT}`);
    } else {
        win.loadURL(formatUrl({
            pathname: path.join(__dirname, 'index.html'),
            protocol: 'file',
            slashes:  true,
        }));
    }

    win.on('closed', () => {
        mainWindow = null;
    });

    win.webContents.on('devtools-opened', () => {
        win.focus();
        setImmediate(() => {
            win.focus();
        });
    });

    win.once('ready-to-show', () => {
        win.show();
    });

    return win;
}

function createTray() {
    const t = new Tray(trayIconPath());

    const menu = Menu.buildFromTemplate([
        {
            type : "normal",
            label: 'Показать/Скрыть',
            click: toggleMainWindow,
        },
        {
            type: "separator",
        },
        {
            type : "normal",
            label: 'Выход',
            click: quit,
        },
    ]);

    t.on('click', toggleMainWindow);

    t.setToolTip('Сервер печати');
    t.setContextMenu(menu);

    return t;
}

function toggleMainWindow() {
    if (mainWindow) {
        // TODO: Hide instead?
        // TODO: Recreating is slow, but it's a rare case.
        mainWindow.close();
        mainWindow = null;
    } else {
        mainWindow = createMainWindow();
    }
}

// Override default behavior: we don't want to quit when window is closed.
app.on('window-all-closed', () => {});

app.on('activate', () => {
    // on macOS it is common to re-create a window even after all windows have
    // been closed
    if (mainWindow === null) {
        mainWindow = createMainWindow();
    }
});

// create main BrowserWindow when electron is ready
app.on('ready', () => {
    const shouldShowWindow = !process.argv.includes('--silent');

    if (shouldShowWindow) {
        mainWindow = createMainWindow();
    }

    tray = createTray();

    if (settings.get('server.autostart')) {
        const address = settings.get('server.ip');
        const port = settings.get('server.port');
        if (address && port) {
            startServer(address, port);
        }
    }
});

/**
 * @type {Express}
 */
const expressApp = express();
let appListener;
/**
 * @type Electron.WebContents
 */
let webContents;

expressApp.use(function(req, res, next) {
    res.set('Access-Control-Allow-Origin', '*');
    next();
});
expressApp.use(bodyParser.urlencoded());

expressApp.get('/printers', (req, res) => {
    res.json(webContents ? webContents.getPrinters() : null);
});

expressApp.post('/print', (req, res) => {
    const jobs = req.body.jobs;
    d('Printing %d jobs', jobs.length);
    Promise.all(jobs.map(job => {
        return printUrl(job.url, job.printer).then(() => true, () => false);
    })).then(results => {
        res.json(results);
    });
});

ipcMain.on('get-printers', e => {
    webContents = e.sender;
    e.returnValue = webContents.getPrinters();
});

ipcMain.on('print', ({ sender }, { url, printer }) => {
    webContents = sender;
    printUrl(url, printer).then(() => {
        webContents.send('print-result', { success: true });
    }, error => {
        webContents.send('print-result', { success: false, error });
    });
});

ipcMain.on('get-network-interfaces', e => {
    webContents = e.sender;
    e.returnValue = os.networkInterfaces();
});

ipcMain.on('start-server', ({ sender }, { hostname, port }) => {
    webContents = sender;
    startServer(hostname, port).then(() => {
        webContents.send('server-state', 'running');
    });
});

ipcMain.on('stop-server', ({ sender }) => {
    d('Stopping server...');
    webContents = sender;
    if (!appListener) {
        d('Server is not started');
        webContents.send('server-state', 'stopped');
        tray.setToolTip('Сервер печати - Остановлен');
        return;
    }
    appListener.close(() => {
        d('Server stopped');
        webContents.send('server-state', 'stopped');
        tray.setToolTip('Сервер печати - Остановлен');
        appListener = null;
    });
});

ipcMain.on('get-server-state', e => {
    webContents = e.sender;
    if (appListener) {
        webContents.send('server-state', 'running');
    } else {
        webContents.send('server-state', 'stopped');
    }
});

function startServer(hostname, port) {
    d('Starting server...');
    return new Promise(resolve => {
        appListener = expressApp.listen(port, hostname, () => {
            const addr = appListener.address();
            d('Server started on %o', addr);
            tray.setToolTip(`Сервер печати - Запущен на ${addr.address}:${addr.port}`);
            resolve();
        });
    });
}

function printUrl(url, printer) {
    if (!webContents) {
        return Promise.reject(new Error('No web contents'));
    }
    d('Printing URL %s on printer %s', url, printer);
    const w = new BrowserWindow({
        show: false,
    });
    w.loadURL(url, { userAgent: 'ElectronPrintServer / 0.0.1' });

    return new Promise((resolve, reject) => {
        w.webContents.once('did-finish-load', () => {
            w.webContents.printToPDF({}, (err, data) => {
                w.close();
                if (err) {
                    d('Print to PDF error: %s', err.message);
                    reject(err);
                    return;
                }
                const fileName = tmp.fileSync({
                    prefix: 'print_',
                    postfix: '.pdf',
                }).name;
                fs.writeFile(fileName, data, err => {
                    if (err) {
                        d('PDF write error: %s', err.message);
                        reject(err);
                        return;
                    }
                    printFile(fileName, printer).then(out => {
                        d('Print output: %s', out);
                        resolve(out);
                    }, err => {
                        d('Print error: %s', err.message);
                        reject(err);
                    });
                })
            });
        });
    });
}

function printFile(fileName, printer) {
    return new Promise((resolve, reject) => {
        let command;
        // Not supporting other platforms
        // noinspection SwitchStatementWithNoDefaultBranchJS
        switch (process.platform) {
            case 'linux':
                command = `lp -d "${printer}" "${fileName}"`;
                break;
            case 'win32':
                command = `${extraResourcePath('SumatraPDFx64.exe')} -print-to "${printer}" -silent "${fileName}"`;
                break;
        }
        childProcess.exec(command, {}, (err, stdout) => {
            if (err) {
                d('Shell exec error: %s', err.message);
                reject(err);
                return;
            }
            resolve(stdout);
        });
    });
}

function extraResourcePath(p) {
    return path.join(__dirname, '..', 'external', p);
}

function trayIconPath() {
    switch (process.platform) {
        case 'linux':
            return path.join(__static, '/icons/linux/tray-icon.png');
        case 'win32':
            return path.join(__static, '/icons/win32/tray-icon.ico');
        default:
            return null;
    }
}

function quit() {
    if (appListener) {
        appListener.close(() => {
            app.quit();
        });
    } else {
        app.quit();
    }

}
