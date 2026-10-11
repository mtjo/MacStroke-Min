<template>
  <view class="keypad">
    <view class="line">
      <input
        class="draft"
        v-model="draft"
        placeholder="打出来的字直接送进 Mac"
        placeholder-class="draft-hint"
        confirm-type="send"
        @confirm="send"
        @blur="$emit('relayout')"
      />
      <button class="act" size="mini" @tap="send">发送</button>
      <button class="act" size="mini" @tap="$emit('close')">收起</button>
    </view>

    <view class="line">
      <view
        v-for="mod in modChips"
        :key="mod.name"
        class="chip"
        :class="{ held: on(mod.name) }"
        hover-class="chip-hover"
        @tap="toggle(mod.name)"
      >{{ mod.glyph }}</view>
      <text class="preview">{{ preview }}</text>
    </view>

    <view class="rows">
      <view class="row" v-for="(row, index) in keyRows" :key="index">
        <view
          v-for="cap in row"
          :key="cap.name"
          class="cap"
          :class="{ wide: cap.wide }"
          hover-class="cap-hover"
          @tap="press(cap)"
        >{{ cap.glyph }}</view>
      </view>
    </view>

    <text class="note" v-if="note">{{ note }}</text>
  </view>
</template>

<script>
import { remote } from '@/utils/socket.js'

// 修饰键的顺序就是按下顺序（⌃⌥⇧⌘），和 Mac 那边 pressOrder 一致；
// 名字用协议里的写法（cmd/alt/shift/ctrl），Mac 的解析表认这几个。
const MODS = [
  { name: 'ctrl', glyph: '⌃' },
  { name: 'alt', glyph: '⌥' },
  { name: 'shift', glyph: '⇧' },
  { name: 'cmd', glyph: '⌘' },
]

const GLYPH = {
  escape: 'Esc',
  tab: 'Tab',
  space: '空格',
  return: '↵',
  delete: '⌫',
  left: '←',
  down: '↓',
  up: '↑',
  right: '→',
}

// 键帽按 US 物理键位排：发出去的是键名，Mac 换成虚拟键码，所以这套排布
// 就是键盘本身的排布，换布局也不会错位。
const KEYS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((name) => ({ name, glyph: name })),
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'].map((name) => ({ name, glyph: name })),
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'].map((name) => ({ name, glyph: name })),
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'].map((name) => ({ name, glyph: name })),
  [
    { name: 'escape', glyph: GLYPH.escape },
    { name: 'tab', glyph: GLYPH.tab },
    { name: 'space', glyph: GLYPH.space, wide: true },
    { name: 'return', glyph: GLYPH.return },
    { name: 'delete', glyph: GLYPH.delete },
    { name: 'left', glyph: GLYPH.left },
    { name: 'down', glyph: GLYPH.down },
    { name: 'up', glyph: GLYPH.up },
    { name: 'right', glyph: GLYPH.right },
  ],
]

/**
 * 文本输入与快捷键面板（协议 v3）。
 *
 * 为什么字母要一格一格铺出来：手机键盘敲出来的字符只能走文本注入那条路，
 * 而 ⌘C 这类快捷键要的是「真的按下 C 这个键」。所以这里给的是键位，
 * 修饰键单独勾选、按完不清空——连着按 ⌘C ⌘V 时不该每颗都要重勾一遍。
 *
 * 这一面板出现在回显页时会把画布挤小，开合与软键盘收起都由外面重量一次坐标
 * （relayout/close），不然点按落点会整体偏掉。
 */
export default {
  name: 'InputKeypad',

  data() {
    return {
      draft: '',
      mods: [],
      note: '',
    }
  },

  computed: {
    /// 两张表都是常量，走 computed 而不是 data：Vue 给 data 里的每个键帽对象
    /// 都套一层响应式代理，而这五十来个格子从不会变。
    modChips() {
      return MODS
    },
    keyRows() {
      return KEYS
    },
    /// 当前勾选的修饰键串，直接就是报文字段 m 的写法。
    modifiers() {
      return MODS.filter((mod) => this.mods.indexOf(mod.name) >= 0)
        .map((mod) => mod.name)
        .join('+')
    },
    /// 下一颗键按下去会是什么组合，写在旁边免得勾完忘了自己勾过什么。
    preview() {
      if (!this.mods.length) return '按下面任一键'
      return MODS.filter((mod) => this.mods.indexOf(mod.name) >= 0)
        .map((mod) => mod.glyph)
        .join('') + ' + 键'
    },
  },

  methods: {
    on(name) {
      return this.mods.indexOf(name) >= 0
    },

    toggle(name) {
      const index = this.mods.indexOf(name)
      if (index >= 0) this.mods.splice(index, 1)
      else this.mods.push(name)
      this.mods = this.mods.slice()
      this.note = ''
    },

    press(cap) {
      this.fail(remote.sendKey(cap.name, this.modifiers), '按键没发出去（先连上 Mac）')
    },

    send() {
      const text = this.draft
      if (!text) return
      if (remote.sendText(text)) {
        // 发出去就清空：留着的话下一次不小心再点「发送」会把同一段字打两遍。
        this.draft = ''
        this.note = ''
        return
      }
      this.fail(false, '文本没发出去（先连上 Mac）')
    },

    fail(sent, message) {
      if (!sent) this.note = message
      return sent
    },
  },
}
</script>

<style>
.keypad {
  border-radius: 20rpx;
  background: #ffffff;
  padding: 16rpx;
  margin-bottom: 8rpx;
}

.line {
  display: flex;
  align-items: center;
  margin-bottom: 12rpx;
}

.draft {
  flex: 1;
  height: 60rpx;
  line-height: 60rpx;
  font-size: 28rpx;
  padding: 0 16rpx;
  background: #f2f2f7;
  border-radius: 12rpx;
}

.draft-hint {
  color: #c7c7cc;
  font-size: 26rpx;
}

.act {
  margin-left: 12rpx;
  margin-right: 0;
  font-size: 24rpx;
}

.chip {
  width: 76rpx;
  height: 56rpx;
  line-height: 56rpx;
  margin-right: 12rpx;
  text-align: center;
  border-radius: 12rpx;
  background: #f2f2f7;
  color: #1c1c1e;
  font-size: 30rpx;
}

.chip.held {
  background: #ff9500;
  color: #ffffff;
}

.chip-hover {
  opacity: 0.6;
}

/* 组合预览固定占位：文字长短不能把这一行顶高，画布跟着挪就全点偏了。 */
.preview {
  flex: 1;
  text-align: right;
  font-size: 22rpx;
  color: #8e8e93;
}

.row {
  display: flex;
  margin-bottom: 8rpx;
}

.cap {
  flex: 1;
  height: 64rpx;
  line-height: 64rpx;
  margin-right: 8rpx;
  text-align: center;
  border-radius: 10rpx;
  background: #f2f2f7;
  color: #1c1c1e;
  font-size: 26rpx;
}

.cap:last-child {
  margin-right: 0;
}

/* 空格在最后一行里多占一格，剩下的键挤到右边。 */
.cap.wide {
  flex: 2;
}

.cap-hover {
  opacity: 0.6;
}

.note {
  display: block;
  margin-top: 8rpx;
  font-size: 22rpx;
  color: #ff3b30;
}
</style>
