<template>
  <div>
    <div>
      <h3>Cài đặt máy chủ</h3>
      <select v-model="serverIp" :disabled="serverState === 'running'">
        <option v-for="ip in availableIps" :value="ip" v-bind:key="ip">
          {{ ip }}
        </option>
      </select>
      <input
        type="text"
        v-model="serverPort"
        :disabled="serverPort == '3179'"
        placeholder="3179"
      />
      <button
        @click="startServer()"
        :disabled="
          serverState === 'running' ||
          !serverIp ||
          (serverHttps && (!httpsCert || !httpsCertKey))
        "
      >
        On
      </button>
      <button @click="stopServer()" :disabled="serverState !== 'running'">
        Off
      </button>
      <div>
        Tình trạng: {{ serverStateText }}
        <button v-if="serverState === 'running'" @click="copyAddress()">
          Sao chép địa chỉ
        </button>
      </div>
    </div>
    <div>
      <h3>Kiểm tra bản in</h3>
      <input type="text" v-model="urlToPrint" />
      <select v-model="printer">
        <option
          v-for="p in availablePrinters"
          :value="p.name"
          v-bind:key="p.name"
        >
          {{ p.name }}
        </option>
      </select>
      <button @click="print()" :disabled="printer === null">Gõ phím</button>
      {{ printResult }}
    </div>
    <div>
      <h3>Chọn loại phần mềm portable</h3>
      <select v-model="typePrint">
        <option
          v-bind:key="p.value"
          v-for="p in [
            {
              name: 'Native',
              value: 'native',
            },
            {
              name: 'PDFtoPrinter (Ưu tiên tốc độ truyền vào máy in)',
              value: 'PDFtoPrinter',
            },
            {
              name: 'SumatraPDF (Có thể config sẵn hướng in, in 2 mặt)',
              value: 'SumatraPDF',
            },
          ]"
          :value="p.value"
        >
          {{ p.name }}
        </option>
      </select>
    </div>
  </div>
</template>

<script>
import { clipboard, ipcRenderer } from 'electron';
import settings from 'electron-settings';
import flatten from 'lodash/flatten';

const getSetting = (path, def) => {
  return settings.hasSync(path) ? settings.getSync(path) : def;
};

export default {
  data() {
    return {
      availableIps: [],
      serverIp: getSetting('server.ip', 'localhost'),
      serverPort: getSetting('server.port', 3179),
      serverHttps: getSetting('server.https.enabled', false),
      httpsCert: getSetting('server.https.cert', ''),
      httpsCertKey: getSetting('server.https.certKey', ''),
      serverState: '',
      serverAutostart: getSetting('server.autostart', true),
      availablePrinters: [],
      printer: null,
      urlToPrint: '',
      printResult: '',
      typePrint: getSetting('server.type.print', 'native'),
    };
  },
  created() {
    this.initMainProcessListeners();
    this.updateNetworkInterfaces();
    this.updatePrinters();
    this.updateServerState();
  },
  destroyed() {
    this.stopServer();
  },
  computed: {
    serverStateText() {
      switch (this.serverState) {
        case 'running':
          return `running ${this.serverAddress}`;
        case 'stopped':
          return 'stopped';
        default:
          return 'stopped';
      }
    },
    serverAddress() {
      return `${this.serverIp}:${this.serverPort}`;
    },
  },
  watch: {
    serverIp(ip) {
      settings.setSync('server.ip', ip);
    },
    serverPort(port) {
      settings.setSync('server.port', port);
    },
    serverHttps(useHttps) {
      settings.setSync('server.https.enabled', useHttps);
    },
    httpsCert(cert) {
      settings.setSync('server.https.cert', cert);
    },
    httpsCertKey(key) {
      settings.setSync('server.https.certKey', key);
    },
    serverAutostart(autostart) {
      settings.setSync('server.autostart', autostart);
    },
    typePrint(type) {
      settings.setSync('server.type.print', type);
    },
  },
  methods: {
    updatePrinters() {
      this.availablePrinters = ipcRenderer.sendSync('get-printers');
    },
    initMainProcessListeners() {
      ipcRenderer.on('server-state', (e, state) => {
        this.serverState = state;
      });
    },
    updateNetworkInterfaces() {
      const interfaces = ipcRenderer.sendSync('get-network-interfaces');
      this.availableIps = flatten(Object.values(interfaces))
        .filter((addr) => addr.family === 'IPv4' && !addr.internal)
        .map((addr) => addr.address)
        .concat('localhost');
    },
    updateServerState() {
      ipcRenderer.send('get-server-state');
    },
    print() {
      ipcRenderer.send('print', {
        printer: this.printer,
        url: this.urlToPrint,
      });
      ipcRenderer.once('print-result', (e, { success, error }) => {
        this.printResult = success ? 'ok' : 'fail: ' + JSON.stringify(error);
      });
    },
    startServer() {
      ipcRenderer.send('start-server', {
        port: this.serverPort,
        hostname: this.serverIp,
        httpsSettings: {
          useHttps: this.serverHttps,
          httpsCert: this.httpsCert,
          httpsCertKey: this.httpsCertKey,
        },
      });
    },
    stopServer() {
      ipcRenderer.send('stop-server');
    },
    copyAddress() {
      clipboard.writeText(this.serverAddress);
    },
  },
};
</script>
