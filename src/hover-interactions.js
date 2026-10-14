'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetHover = factory();
})(typeof window === 'object' ? window : globalThis, () => {
  const messages = {
    morning: [
      '早上好呀！记得吃早餐，今天也慢慢加油。',
      '早上好！先喝口水，再开始今天的事情吧。',
      '早上好呀！伸个懒腰，我陪你开启新的一天。',
      '新的一天开始啦，先挑一件小事做做吧。',
      '早呀！今天也请多关照，我的加油位准备好了。',
      '早餐想吃什么呢？别让肚子空着开工呀。',
      '早安！还没完全清醒的话，就慢慢进入状态吧。',
      '今天想先做什么？我陪你从第一步开始。',
      '早上好！给自己留一点从容，不用一醒来就赶。',
      '来，轻轻转转肩膀，准备迎接今天的小任务。',
      '新的一天不必满分，有一点进展就很棒。',
      '早呀！送你一个挥手，还有一份今天的加油。',
      '先把桌面收拾舒服，再慢慢开始也可以呀。',
      '今天的待办再长，也是一件一件完成的。',
      '早上好！忙起来之前，先照顾好自己哦。',
      '如果今天有点紧张，就先做最容易的那一步吧。',
      '早呀！路过也可以和我打个招呼，我很欢迎。',
      '今天也一起努力吧，休息的时候记得带上我。',
      '新的早晨，昨天没做完的事情今天接着来。',
      '早安！我把花球举起来了，给你开工加加油。',
    ],
    noon: [
      '中午好呀！忙完这一会儿，记得好好吃午饭。',
      '中午好！休息一下眼睛，午饭也要按时吃哦。',
      '到午饭时间啦，先让肚子也得到一点关照。',
      '上午辛苦了！中午给自己一个小小的暂停吧。',
      '午饭想好吃什么了吗？希望你吃得满足。',
      '中午好！先放松肩膀，再决定下午的安排吧。',
      '事情先告一段落，饭要一口一口好好吃呀。',
      '中场休息到啦！我的花球也想歇一小会儿。',
      '午饭后有空的话，起身走上几步吧。',
      '中午好呀！这次挥手就当是午间的小问候。',
      '上午没做完也没关系，下午还可以接着来。',
      '可以暂时把视线从屏幕上挪开，看看远处呀。',
      '中午啦，给忙碌的自己留一点吃饭的时间。',
      '吃饭的时候慢一点，让午休也有点悠闲吧。',
      '忙过一上午，记得看看杯子里还有没有水。',
      '如果有点困，就闭目歇一小会儿再继续吧。',
      '中午好！下午的事情，等吃饱再慢慢安排。',
      '给你送来一份午间加油，记得签收呀。',
      '午休想安静一点的话，我就在旁边陪着你。',
      '中午见到你啦！愿接下来的半天顺顺利利。',
    ],
    afternoon: [
      '下午好呀！喝点水，活动一下肩膀吧。',
      '下午好！盯屏幕久了，看看远处，让眼睛歇一歇。',
      '下午好呀！累了就歇一小会儿，我会陪着你。',
      '下午的加油时间到啦！我的花球已经就位。',
      '卡住的时候，换个小任务做做也可以呀。',
      '不必一下子做完所有事，先完成眼前这一点。',
      '下午好！给自己留几分钟，起来走走吧。',
      '来和我挥挥手，就当是忙碌中的一个小休息。',
      '杯子是不是空了？顺手给自己添点水吧。',
      '如果下午有点困，先歇歇再找回节奏。',
      '做完一件小事，也值得给自己一个小庆祝。',
      '下午好呀！今天还有什么想完成的小目标？',
      '眉头可以松一松，我给你送一份轻松的加油。',
      '先把肩膀放下来，别一直绷着自己呀。',
      '休息几分钟也算照顾自己，不用觉得着急。',
      '想不出答案时，可以把问题拆成小一点的步骤。',
      '下午的问候送到！希望这一小会儿能让你开心。',
      '进度慢一点也没关系，找到适合自己的节奏吧。',
      '手边的事情忙完，记得给自己留点喜欢的时间。',
      '嗨，我在这里！需要一点加油就来看看我。',
    ],
    evening: [
      '晚上好呀！今天辛苦啦，记得好好吃晚饭。',
      '晚上好！放松一下肩膀，给自己一点休息时间吧。',
      '晚上好呀！不管今天过得怎样，都给你加加油。',
      '忙了一天，晚饭想吃点什么呢？',
      '晚上啦，今天的小进展也值得被记住。',
      '如果事情告一段落，就给自己一点放松的时间。',
      '晚上好！还有事情要忙的话，我陪你慢慢来。',
      '今天有没有一件让你开心的小事？',
      '晚间加油送到！也别忘了给自己安排休息。',
      '把肩膀轻轻放松，今天不用一直紧绷着啦。',
      '晚饭要好好吃，喜欢的东西也要慢慢享受。',
      '今天没完成的事情，可以先记下来再安排。',
      '晚上好呀！路过我的时候，挥个手就很开心。',
      '如果今天有点累，今晚就对自己温柔一点吧。',
      '给今天的自己一点肯定，小努力也算数。',
      '晚上想安静待一会儿的话，我就在这里。',
      '今天的加油还有一份，送给现在的你。',
      '忙完后挑件喜欢的小事，给今晚添点开心吧。',
      '晚上好！歇一歇眼睛，再决定要不要继续。',
      '我来挥挥花球，祝你有一个舒服的晚上。',
    ],
    night: [
      '夜深啦！事情可以慢慢来，也要留时间好好睡觉。',
      '还没睡呀？喝口水，早点休息，我明天也会陪你。',
      '夜里好呀！这次小声给你加油，不吵到你。',
      '如果有点困，就把剩下的事情先记下来吧。',
      '已经很晚啦，睡前给自己留一点放松的时间。',
      '还在忙的话，记得偶尔让肩膀和眼睛歇歇。',
      '深夜的问候送到，希望你今晚能睡得安稳。',
      '今天先做到这里也可以，明天还有新的时间。',
      '如果脑袋有点乱，把想法写下来再慢慢整理吧。',
      '夜深了，我把加油声调小一点，陪你慢慢来。',
      '准备睡觉的话，先和屏幕道个晚安吧。',
      '今晚辛苦啦，休息也值得被认真安排。',
      '还有最后一点要忙吗？做完记得好好休息。',
      '夜里见到你啦，别忘了照顾自己的作息。',
      '现在不想说话也没关系，我安静陪你一会儿。',
      '今天的小烦恼，可以先放一放再睡呀。',
      '晚安可以提前说，愿你今晚做个轻松的梦。',
      '我的花球也准备收好啦，你也别太累哦。',
      '明天再来和我打招呼吧，我还在这里等你。',
      '给今天画个小句号，剩下的留到休息好以后。',
    ],
  };
  function timeSlot(hour) {
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new RangeError('Expected local hour 0–23');
    return hour < 5 || hour >= 23 ? 'night' : hour < 11 ? 'morning' : hour < 13 ? 'noon' : hour < 18 ? 'afternoon' : 'evening';
  }
  class GreetingMessages {
    constructor(random = Math.random) { this.random = random; this.previous = new Map(); }
    next(date = new Date()) {
      const slot = timeSlot(date.getHours()), pool = messages[slot];
      const choices = pool.filter(text => text !== this.previous.get(slot));
      const index = Math.min(choices.length - 1, Math.max(0, Math.floor(this.random() * choices.length)));
      const text = choices[index]; this.previous.set(slot, text); return { slot, text };
    }
  }
  class HoverInteractions {
    constructor({ trigger, now = () => performance.now(), dwellMs = 250, cooldownMs = 20000, leaveMs = 180 }) {
      Object.assign(this, { trigger, now, dwellMs, cooldownMs, leaveMs });
      this.armed = true; this.enteredAt = null; this.outsideAt = null;
      this.leftByPointer = false; this.nextGreeting = 0;
    }
    suspend() { this.armed = false; this.enteredAt = null; }
    update({ hit, action, eligible = true, pressed = false, moved = false }) {
      const time = this.now();
      if (!hit) {
        this.enteredAt = null;
        if (this.outsideAt === null) this.outsideAt = time;
        this.leftByPointer ||= moved;
        if (this.leftByPointer && time - this.outsideAt >= this.leaveMs) this.armed = true;
        return;
      }
      this.outsideAt = null; this.leftByPointer = false;
      if (!eligible || pressed || !['idle', 'run'].includes(action)) { this.suspend(); return; }
      if (!this.armed) return;
      if (action === 'run') {
        this.suspend(); this.trigger('fall'); return;
      }
      if (this.enteredAt === null) this.enteredAt = time;
      if (time - this.enteredAt >= this.dwellMs && time >= this.nextGreeting) {
        this.suspend();
        if (this.trigger('greet') !== false) this.nextGreeting = time + this.cooldownMs;
      }
    }
    snapshot() { return { armed: this.armed, nextGreeting: this.nextGreeting, enteredAt: this.enteredAt }; }
  }
  return { HoverInteractions, GreetingMessages, timeSlot, messages };
});
