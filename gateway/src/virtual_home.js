const BASE_APPLIANCES = [
  {
    id: "light_hub",
    room: "Living Room",
    name: "Hub Main Light (RGB PWM)",
    kind: "light",
    provenance: "hardware",
    hardwarePin: "CTIMER3 PIO4_17..19",
    on: true,
    levelPct: 85,
    watts: 28,
    hwSynced: "light",
    matter: { nodeId: "model-0x01", clusters: ["OnOff (0x0006)", "LevelControl (0x0008)", "ColorControl (0x0300)"] },
    assignedUsers: ["owner", "family", "guest"],
    linkedRules: ["rule_vacancy", "rule_daylight"],
  },
  {
    id: "ac_living",
    room: "Bedroom",
    name: "Inverter AC",
    kind: "climate",
    provenance: "twin",
    hardwarePin: "Synced to MCU ac state",
    on: false,
    watts: 1280,
    ecoWatts: 240,
    targetC: 24,
    fanSpeed: "auto",
    acMode: "cool",
    hwSynced: "ac",
    matter: { nodeId: "model-0x02", clusters: ["Thermostat (0x0201)", "FanControl (0x0202)", "OnOff (0x0006)"] },
    assignedUsers: ["owner", "family"],
    linkedRules: ["rule_night"],
  },
  {
    id: "plug_tv",
    room: "Living Room",
    name: "OLED TV Smart Plug",
    kind: "plug",
    provenance: "twin",
    on: true,
    watts: 115,
    matter: { nodeId: "model-0x03", clusters: ["OnOff (0x0006)", "ElectricalMeasurement (0x0B04)"] },
    assignedUsers: ["owner", "family", "guest"],
    linkedRules: [],
  },
  {
    id: "lamp_living",
    room: "Living Room",
    name: "Floor Ambient Lamp",
    kind: "light",
    provenance: "twin",
    on: false,
    watts: 18,
    matter: { nodeId: "model-0x04", clusters: ["OnOff (0x0006)", "LevelControl (0x0008)"] },
    assignedUsers: ["owner", "family", "guest"],
    linkedRules: ["rule_vacancy"],
  },
  {
    id: "fridge",
    room: "Kitchen",
    name: "Smart Inverter Fridge",
    kind: "appliance",
    provenance: "twin",
    on: true,
    watts: 48,
    compressorWatts: 145,
    doorOpen: false,
    matter: { nodeId: "model-0x05", clusters: ["TemperatureMeasurement (0x0402)", "BooleanState (0x0045)"] },
    assignedUsers: ["owner", "family"],
    linkedRules: [],
  },
  {
    id: "plug_kettle",
    room: "Kitchen",
    name: "Induction Kettle Plug",
    kind: "plug",
    provenance: "twin",
    on: false,
    watts: 1750,
    matter: { nodeId: "model-0x06", clusters: ["OnOff (0x0006)", "ElectricalMeasurement (0x0B04)"] },
    assignedUsers: ["owner", "family"],
    linkedRules: ["rule_overload"],
  },
  {
    id: "fan_bed",
    room: "Bedroom",
    name: "Ceiling BLDC Fan",
    kind: "fan",
    provenance: "twin",
    hardwarePin: "Synced to MCU fan state",
    on: false,
    watts: 42,
    hwSynced: "fan",
    matter: { nodeId: "model-0x07", clusters: ["FanControl (0x0202)", "OnOff (0x0006)"] },
    assignedUsers: ["owner", "family"],
    linkedRules: ["rule_vacancy"],
  },
  {
    id: "lamp_bed",
    room: "Bedroom",
    name: "Bedside Warm Lamp",
    kind: "light",
    provenance: "twin",
    on: false,
    watts: 12,
    matter: { nodeId: "model-0x08", clusters: ["OnOff (0x0006)"] },
    assignedUsers: ["owner", "family"],
    linkedRules: ["rule_night"],
  },
  {
    id: "pad_tx",
    room: "Office",
    name: "ElectraWireless Power Pad",
    kind: "wireless_power",
    provenance: "twin",
    hardwarePin: "Coupled to J11 Type-C PIO5_7",
    on: false,
    watts: 15,
    coilTempC: 29.5,
    efficiencyPct: 84.0,
    faultInjected: false,
    matter: { nodeId: "model-0x09", clusters: ["ElectricalMeasurement (0x0B04)", "TemperatureMeasurement (0x0402)"] },
    assignedUsers: ["owner", "family"],
    linkedRules: ["rule_coil"],
  },
  {
    id: "plug_desk",
    room: "Office",
    name: "Workstation Dock Plug",
    kind: "plug",
    provenance: "twin",
    on: true,
    watts: 65,
    matter: { nodeId: "model-0x0A", clusters: ["OnOff (0x0006)", "ElectricalMeasurement (0x0B04)"] },
    assignedUsers: ["owner", "family"],
    linkedRules: ["rule_vacancy"],
  },
];

export class VirtualHome {
  constructor() {
    this.appliances = new Map(BASE_APPLIANCES.map((a) => [a.id, { ...a }]));
    this.powerHistory = [];
    this.peakDemoActive = false;
    this.suggestionDismissedUntil = 0;
    this.lastSpikeAlertMs = 0;
    this.lastPadWarnMs = 0;
    this.lastPadCritMs = 0;
    this.lastPeakNudgeMs = 0;
    this.prevDock = null;
    this.tickCount = 0;
  }

  restoreState(saved) {
    if (!saved || typeof saved !== "object") return;
    if (typeof saved.peakDemoActive === "boolean") {
      this.peakDemoActive = saved.peakDemoActive;
    }
    if (saved.appliances && typeof saved.appliances === "object") {
      for (const [id, partial] of Object.entries(saved.appliances)) {
        const dev = this.appliances.get(id);
        if (!dev || !partial) continue;
        if (typeof partial.on === "boolean") dev.on = partial.on;
        if (typeof partial.targetC === "number") dev.targetC = partial.targetC;
        if (typeof partial.fanSpeed === "string") dev.fanSpeed = partial.fanSpeed;
        if (typeof partial.acMode === "string") dev.acMode = partial.acMode;
        if (typeof partial.doorOpen === "boolean") dev.doorOpen = partial.doorOpen;
        if (typeof partial.faultInjected === "boolean") dev.faultInjected = partial.faultInjected;
      }
    }
  }

  exportState() {
    const appliances = {};
    for (const [id, dev] of this.appliances.entries()) {
      appliances[id] = {
        on: dev.on,
        targetC: dev.targetC,
        fanSpeed: dev.fanSpeed,
        acMode: dev.acMode,
        doorOpen: dev.doorOpen,
        faultInjected: dev.faultInjected,
      };
    }
    return { peakDemoActive: this.peakDemoActive, appliances };
  }

  syncWithHardwareState(telem) {
    if (!telem) return;
    const hubLight = this.appliances.get("light_hub");
    const ac = this.appliances.get("ac_living");
    const fan = this.appliances.get("fan_bed");
    const pad = this.appliances.get("pad_tx");

    if (hubLight && typeof telem.light === "boolean") {
      hubLight.on = telem.light;
      hubLight.levelPct = Number(telem.light_pct ?? (telem.light ? 80 : 0));
    }
    if (ac && typeof telem.ac === "boolean") {
      ac.on = telem.ac;
    }
    if (fan && typeof telem.fan === "boolean") {
      fan.on = telem.fan;
    }
    if (pad && typeof telem.dock === "boolean") {
      if (this.prevDock !== null && telem.dock !== this.prevDock) {
        pad.on = telem.dock || Boolean(pad.faultInjected);
      } else if (this.prevDock === null && telem.dock) {
        pad.on = true;
      }
      this.prevDock = telem.dock;
    }
    if (telem.safety || telem.away) {
      for (const dev of this.appliances.values()) {
        if (dev.id !== "fridge") {
          dev.on = false;
        }
      }
    }
  }

  setAppliance(id, state, extra = {}) {
    const dev = this.appliances.get(id);
    if (!dev) return null;
    if (typeof state === "boolean") dev.on = state;
    if (typeof extra.targetC === "number") dev.targetC = Math.min(30, Math.max(16, Math.round(extra.targetC)));
    if (typeof extra.fanSpeed === "string" && ["auto", "low", "med", "high"].includes(extra.fanSpeed)) {
      dev.fanSpeed = extra.fanSpeed;
    }
    if (typeof extra.acMode === "string" && ["cool", "eco", "fan"].includes(extra.acMode)) {
      dev.acMode = extra.acMode;
    }
    if (typeof extra.doorOpen === "boolean") dev.doorOpen = extra.doorOpen;
    if (typeof extra.faultInjected === "boolean") dev.faultInjected = extra.faultInjected;
    return { ...dev };
  }

  turnAllOff() {
    for (const dev of this.appliances.values()) {
      if (dev.id !== "fridge") {
        dev.on = false;
        if (dev.id === "pad_tx") dev.faultInjected = false;
      }
    }
  }

  turnLightsOff() {
    const changed = [];
    for (const dev of this.appliances.values()) {
      if (dev.kind === "light") {
        dev.on = false;
        changed.push(dev.id);
      }
    }
    return changed;
  }

  activateEnergySaver() {
    this.setAppliance("ac_living", undefined, { acMode: "eco", targetC: 26, fanSpeed: "low" });
    for (const dev of this.appliances.values()) {
      if (dev.kind === "light" && dev.on && typeof dev.levelPct === "number" && dev.levelPct > 40) {
        dev.levelPct = 40;
      }
    }
    for (const id of ["plug_tv", "plug_desk", "plug_kettle"]) {
      this.setAppliance(id, false);
    }
  }

  activateNightMode() {
    this.setAppliance("plug_tv", false);
    this.setAppliance("lamp_living", false);
    this.setAppliance("plug_kettle", false);
    this.setAppliance("plug_desk", false);
    this.setAppliance("fan_bed", false);
    this.setAppliance("lamp_bed", true);
    this.setAppliance("ac_living", true, { targetC: 25, fanSpeed: "low", acMode: "eco" });
    this.setAppliance("light_hub", true);
  }

  toggleRoom(roomName, targetOn) {
    const updated = [];
    for (const dev of this.appliances.values()) {
      if (dev.room === roomName && dev.id !== "fridge") {
        dev.on = Boolean(targetOn);
        updated.push({ ...dev });
      }
    }
    return updated;
  }

  step(telem = {}, now = Date.now(), rules = []) {
    this.tickCount += 1;
    const events = [];
    const ruleMap = new Map(rules.map((r) => [r.id, r]));
    const ruleOn = (id, def = true) => {
      const r = ruleMap.get(id);
      return r ? Boolean(r.enabled) : def;
    };

    const ambientC = Number.isFinite(Number(telem.temp_c)) ? Number(telem.temp_c) : 28.0;
    const autoEco = Boolean(telem.eco);
    const safetyLatched = Boolean(telem.safety);

    // Fridge duty cycle and optional door-open surge
    const fridge = this.appliances.get("fridge");
    const compressorRunning = fridge.doorOpen || this.tickCount % 16 < 5;
    const fridgeW = fridge.on ? (compressorRunning ? fridge.compressorWatts : fridge.watts) : 0;

    // ElectraWireless transmitter thermal & coil efficiency model
    const pad = this.appliances.get("pad_tx");
    const targetEff = pad.faultInjected ? 54.0 : 84.5;
    pad.efficiencyPct = Number((pad.efficiencyPct + (targetEff - pad.efficiencyPct) * 0.35).toFixed(1));

    const padTransferW = pad.on && !safetyLatched ? pad.watts : 0;
    const padLossW =
      padTransferW > 0 ? padTransferW * ((100 - pad.efficiencyPct) / Math.max(10, pad.efficiencyPct)) : 0;
    const targetCoilC = pad.faultInjected
      ? Math.max(ambientC + 28.0, 56.0)
      : ambientC + padLossW * 1.45;
    const rate = pad.faultInjected ? 0.35 : 0.25;
    pad.coilTempC = Number((pad.coilTempC + (targetCoilC - pad.coilTempC) * rate).toFixed(2));

    const coilRuleThreshold = Number(ruleMap.get("rule_coil")?.threshold ?? 52.0);
    if (ruleOn("rule_coil", true)) {
      const critHit = pad.coilTempC >= coilRuleThreshold && now - this.lastPadCritMs > 10000;
      const warnHit = !critHit && pad.coilTempC >= coilRuleThreshold - 4.0 && now - this.lastPadWarnMs > 10000;
      if (critHit || warnHit) {
        if (critHit) this.lastPadCritMs = now;
        else this.lastPadWarnMs = now;
        events.push({
          type: "thermal_pad",
          ruleId: "rule_coil",
          severity: critHit ? "critical" : "warning",
          room: "Office",
          title: "ElectraWireless Coil Over-Temperature",
          detail: `Transmitter coil reached ${pad.coilTempC.toFixed(1)}C (${pad.efficiencyPct}% eff).`,
          triggerMcuSafety: critHit,
        });
      }
    }

    let totalWatts = 0;
    let savedWatts = 0;
    const deviceWatts = {};
    for (const dev of this.appliances.values()) {
      let w = 0;
      if (dev.id === "fridge") {
        w = fridgeW;
      } else if (dev.id === "pad_tx") {
        w = padTransferW > 0 ? Number((padTransferW + padLossW).toFixed(1)) : 0;
      } else if (dev.id === "light_hub") {
        const pct = dev.levelPct ?? (dev.on ? 80 : 0);
        w = dev.on ? Number(((dev.watts * pct) / 100).toFixed(1)) : 0;
        if (dev.on && autoEco && pct < 85) {
          savedWatts += Math.max(0, (dev.watts * 85) / 100 - w);
        }
      } else if (dev.id === "ac_living") {
        if (!dev.on) {
          w = 0;
        } else if (dev.acMode === "fan") {
          w = 55;
          savedWatts += Math.max(0, dev.watts - w);
        } else if (autoEco || dev.acMode === "eco") {
          const tempFactor = Math.max(0.7, Math.min(1.25, 1 + (25 - (dev.targetC ?? 24)) * 0.04));
          w = Number((dev.ecoWatts * tempFactor).toFixed(1));
          const coolRef = dev.watts * Math.max(0.75, Math.min(1.25, 1 + (24 - (dev.targetC ?? 24)) * 0.03));
          savedWatts += Math.max(0, coolRef - w);
        } else {
          const tempFactor = Math.max(0.75, Math.min(1.25, 1 + (24 - (dev.targetC ?? 24)) * 0.03));
          w = Number((dev.watts * tempFactor).toFixed(1));
        }
      } else {
        w = dev.on ? dev.watts : 0;
      }
      dev.currentWatts = w;
      deviceWatts[dev.id] = w;
      totalWatts += w;
    }

    totalWatts = Number(totalWatts.toFixed(1));
    const avgBefore =
      this.powerHistory.length > 0
        ? this.powerHistory.reduce((a, b) => a + b, 0) / this.powerHistory.length
        : totalWatts;

    this.powerHistory.push(totalWatts);
    if (this.powerHistory.length > 20) this.powerHistory.shift();

    const spikeLimit = Number(ruleMap.get("rule_overload")?.threshold ?? 1500);
    if (
      ruleOn("rule_overload", true) &&
      this.powerHistory.length >= 4 &&
      totalWatts > spikeLimit &&
      totalWatts > avgBefore * 1.45 &&
      now - this.lastSpikeAlertMs > 10000
    ) {
      this.lastSpikeAlertMs = now;
      events.push({
        type: "energy_spike",
        ruleId: "rule_overload",
        severity: "warning",
        room: "Kitchen",
        title: "Unusual High-Load Energy Spike",
        detail: `Total draw jumped to ${totalWatts} W vs ${avgBefore.toFixed(0)} W baseline.`,
      });
    }

    const hour = new Date(now).getHours();
    const isPeakWindow = this.peakDemoActive || (hour >= 14 && hour < 16);
    const ac = this.appliances.get("ac_living");
    const needsPeakOpt = isPeakWindow && ac.on && !autoEco && ac.acMode !== "eco" && ac.acMode !== "fan";
    const aiSuggestion =
      needsPeakOpt && now > this.suggestionDismissedUntil
        ? {
            id: "peak_eco",
            title: "2-4 PM Peak Tariff Optimization Ready",
            detail: `AC currently cooling at ${ac.currentWatts} W during peak tariff. Approve Eco + 26C setback to trim ~${Math.max(100, Math.round(ac.currentWatts - ac.ecoWatts))} W?`,
            savedWattsEst: Math.max(100, Math.round(ac.currentWatts - ac.ecoWatts)),
          }
        : null;

    if (needsPeakOpt && now - this.lastPeakNudgeMs > 15000) {
      this.lastPeakNudgeMs = now;
      events.push({
        type: "peak_nudge",
        severity: "info",
        room: "Living Room",
        title: "Peak Tariff Auto-Eco Recommendation",
        detail: "2-4 PM peak tariff window active while AC runs at full load. User approval required.",
      });
    }

    return {
      totalWatts,
      savedWatts: Number(savedWatts.toFixed(1)),
      baselineAvgWatts: Number(avgBefore.toFixed(1)),
      padTempC: pad.coilTempC,
      padEfficiencyPct: pad.efficiencyPct,
      isPeakWindow,
      aiSuggestion,
      appliances: Array.from(this.appliances.values()).map((d) => ({ ...d })),
      deviceWatts,
      events,
    };
  }
}
