#!/usr/bin/env node
import midi from '@tonejs/midi';
const { Midi } = midi;
import { readFile, writeFile, access } from 'fs/promises';
import { program } from 'commander';
import { resolve } from 'path';

/**
 * MIDI 转 Bambu Lab 兼容格式转换器
 * 功能：
 * 1. 将任意 MIDI 转换为 3 音轨格式
 * 2. 智能音符分配算法
 * 3. 保持音乐完整性
 */

// 配置常量
const MAX_TRACKS = 3;
const DEFAULT_TICKS_PER_BEAT = 480;

class MidiConverter {
  constructor() {
    this.ticksPerBeat = DEFAULT_TICKS_PER_BEAT;
  }

  async run() {
    this.setupCLI();
    await this.validateInput();
    
    try {
      const midi = await this.loadMidiFile(this.options.input); // 修正：options => this.options
      const processed = this.processMidi(midi);
      await this.saveOutput(processed);
      
      this.logSuccess();
    } catch (error) {
      this.handleError(error);
    }
  }

  setupCLI() {
    program
      .name('midi2bambu')
      .description('将MIDI转换为3音轨Bambu Lab兼容格式')
      .version('1.1.0')
      .requiredOption('-i, --input <path>', '输入MIDI文件路径')
      .requiredOption('-o, --output <path>', '输出文件路径')
      .option('-v, --verbose', '显示详细处理信息')
      .parse(process.argv);
    
    this.options = program.opts();
  }

  async validateInput() {
    const { input } = this.options;
    
    if (!input.endsWith('.mid') && !input.endsWith('.midi')) {
      throw new Error('输入文件必须是.mid或.midi格式');
    }
    
    try {
      await access(resolve(input)); // 用fs/promises的access
    } catch {
      throw new Error(`无法访问输入文件: ${input}`);
    }
  }

  async loadMidiFile(path) {
    const data = await readFile(resolve(path));
    const midi = new Midi(data);
    this.ticksPerBeat = midi.header.ticksPerBeat || DEFAULT_TICKS_PER_BEAT;
    this.lastLoadedMidi = midi; // 保存原始midi用于tempo等复制

    if (this.options.verbose) {
      console.log(`已加载MIDI文件: ${midi.tracks.length}个原始音轨`);
    }
    
    return midi;
  }

  processMidi(midi) {
    // 三个音轨的名字
    const TRACK_NAMES = ['Main Theme', 'Chord', 'Base'];
    const trackMap = new Map(
      TRACK_NAMES.map(name => [name, []])
    );

    // 收集并排序所有音符
    const allNotes = midi.tracks.flatMap((track, trackIdx) =>
      track.notes.map(note => ({
        midi: note.midi,
        time: note.time,
        duration: note.duration,
        velocity: note.velocity,
        endTime: note.time + note.duration,
        origTrack: trackIdx // 记录原始音轨编号
      }))
    ).sort((a, b) => a.time - b.time || b.midi - a.midi);

    // 优先将同一原始音轨的音符分配到同一目标音轨
    // 记录原始音轨到目标音轨的分配映射
    const origTrackToTarget = new Map();

    const trackState = TRACK_NAMES.map(() => []);
    for (const note of allNotes) {
      let assigned = false;
      // 优先分配到原始音轨已分配的目标轨道
      let preferIdx = origTrackToTarget.has(note.origTrack) ? origTrackToTarget.get(note.origTrack) : null;
      let tryOrder = [...TRACK_NAMES];
      if (preferIdx !== null) {
        // 优先尝试已分配目标轨道
        tryOrder = [TRACK_NAMES[preferIdx], ...TRACK_NAMES.filter((_, i) => i !== preferIdx)];
      } else {
        // 按音高建议
        let idxByPitch = 1; // 默认Chord
        const notesAtTime = allNotes.filter(n=>n.time===note.time);
        if (note.midi === Math.max(...notesAtTime.map(n=>n.midi))) idxByPitch = 0;
        else if (note.midi === Math.min(...notesAtTime.map(n=>n.time).map(n=>n.midi))) idxByPitch = 2;
        if (idxByPitch !== 0) [tryOrder[0], tryOrder[idxByPitch]] = [tryOrder[idxByPitch], tryOrder[0]];
      }

      // 优化：如果preferIdx已存在，且该目标轨道时间上不冲突，则只分配到该轨道，不再尝试其他轨道
      if (preferIdx !== null) {
        const trackName = TRACK_NAMES[preferIdx];
        const notesArr = trackState[preferIdx];
        let overlap = notesArr.find(n =>
          !(note.endTime <= n.time + 1e-6 || note.time >= n.endTime - 1e-6)
        );
        if (!overlap) {
          notesArr.push(note);
          trackMap.get(trackName).push(note);
          assigned = true;
        }
      }

      // 如果未分配成功，才尝试其他轨道
      if (!assigned) {
        for (let i = 0; i < tryOrder.length; i++) {
          const trackName = tryOrder[i];
          const idx = TRACK_NAMES.indexOf(trackName);
          // 如果已尝试过preferIdx则跳过
          if (preferIdx !== null && idx === preferIdx) continue;
          const notesArr = trackState[idx];
          let overlap = notesArr.find(n =>
            !(note.endTime <= n.time + 1e-6 || note.time >= n.endTime - 1e-6)
          );
          if (!overlap) {
            notesArr.push(note);
            trackMap.get(trackName).push(note);
            assigned = true;
            // 建立原始音轨到目标音轨的映射（只在首次分配时）
            if (!origTrackToTarget.has(note.origTrack)) {
              origTrackToTarget.set(note.origTrack, idx);
            }
            if (this.options.verbose && preferIdx !== null) {
              const suggestTrack = TRACK_NAMES[preferIdx];
              console.warn(`转移音符: time=${note.time} midi=${note.midi}，建议轨道${suggestTrack}忙，分配到${trackName}`);
            } else if (this.options.verbose && preferIdx === null && i !== 0) {
              const suggestTrack = tryOrder[0];
              console.warn(`转移音符: time=${note.time} midi=${note.midi}，建议轨道${suggestTrack}忙，分配到${trackName}`);
            }
            break;
          } else {
            // 有重叠，尝试截断
            if (note.time < overlap.time && note.endTime > overlap.time + 1e-6) {
              // 截断到不重叠
              const newDuration = overlap.time - note.time;
              if (newDuration > 0.01) {
                const truncated = { ...note, duration: newDuration, endTime: overlap.time };
                notesArr.push(truncated);
                trackMap.get(trackName).push(truncated);
                assigned = true;
                if (!origTrackToTarget.has(note.origTrack)) {
                  origTrackToTarget.set(note.origTrack, idx);
                }
                if (this.options.verbose) {
                  console.warn(`截断音符: time=${note.time} midi=${note.midi}，原持续${note.duration}，截断为${newDuration}`);
                }
                break;
              }
            }
            // 新增逻辑：如果当前音符完全覆盖在已有音符之后，尝试截断已有音符
            if (overlap.endTime > note.time + 1e-6 && overlap.endTime > note.endTime + 1e-6 && overlap.time < note.time - 1e-6) {
              const overlapNewDuration = note.time - overlap.time;
              if (overlapNewDuration > 0.01) {
                overlap.duration = overlapNewDuration;
                overlap.endTime = overlap.time + overlapNewDuration;
                notesArr.push(note);
                trackMap.get(trackName).push(note);
                assigned = true;
                if (!origTrackToTarget.has(note.origTrack)) {
                  origTrackToTarget.set(note.origTrack, idx);
                }
                if (this.options.verbose) {
                  console.warn(`截断已有音符: time=${overlap.time} midi=${overlap.midi}，新持续${overlapNewDuration}，以容纳新音符 time=${note.time} midi=${note.midi}`);
                }
                break;
              }
            }
          }
        }
      }
      if (!assigned && this.options.verbose) {
        console.warn(`丢弃音符: time=${note.time} midi=${note.midi}，所有音轨时间冲突`);
      }
    }

    // 保证每个音轨音符按时间排序
    for (const notes of trackMap.values()) {
      notes.sort((a, b) => a.time - b.time);
    }

    // 可视化表格数据
    if (this.options.verbose) {
      const table = [];
      for (const [trackName, notes] of trackMap.entries()) {
        for (const note of notes) {
          table.push({
            Track: trackName,
            Time: note.time.toFixed(4),
            End: note.endTime.toFixed(4),
            Duration: note.duration.toFixed(4),
            Midi: note.midi,
            Velocity: note.velocity,
            OrigTrack: note.origTrack
          });
        }
      }
      table.sort((a, b) => parseFloat(a.Time) - parseFloat(b.Time) || a.Track.localeCompare(b.Track));
      console.table(table);
    }

    return trackMap;
  }

  async saveOutput(trackMap) {
    const outputMidi = new Midi();
    outputMidi.header.ticksPerBeat = this.ticksPerBeat;

    // 复制原MIDI的速度（tempo）和拍号（time signature）等全局事件
    if (this.lastLoadedMidi) {
      // 复制所有全局meta事件
      const origHeader = this.lastLoadedMidi.header;
      // 复制tempo
      if (origHeader.tempos && origHeader.tempos.length > 0) {
        origHeader.tempos.forEach(tempo => {
          outputMidi.header.setTempo(tempo.bpm, tempo.tick);
        });
      }
      // 复制time signature
      if (origHeader.timeSignatures && origHeader.timeSignatures.length > 0) {
        origHeader.timeSignatures.forEach(ts => {
          outputMidi.header.timeSignatures.push({
            ticks: ts.ticks,
            timeSignature: ts.timeSignature
          });
        });
      }
      // 复制key signature
      if (origHeader.keySignatures && origHeader.keySignatures.length > 0) {
        origHeader.keySignatures.forEach(ks => {
          outputMidi.header.keySignatures.push({
            ticks: ks.ticks,
            key: ks.key
          });
        });
      }
    }

    // 保证顺序 Main Theme, Chord, Base
    for (const trackName of ['Main Theme', 'Chord', 'Base']) {
      const notes = trackMap.get(trackName);
      const track = outputMidi.addTrack();
      track.name = trackName;
      notes.forEach(note => {
        track.addNote({
          midi: note.midi,
          time: note.time,
          duration: note.duration,
          velocity: note.velocity
        });
      });
    }
    
    await writeFile(
      resolve(this.options.output),
      Buffer.from(outputMidi.toArray())
    );
  }

  logSuccess() {
    if (this.options.verbose) {
      console.log('转换成功完成!');
      console.log(`输出文件: ${resolve(this.options.output)}`);
    } else {
      console.log('✅ 转换完成');
    }
  }

  handleError(error) {
    console.error('❌ 错误:', error.message);
    process.exit(1);
  }
}

// 启动转换器
new MidiConverter().run();