(function () {
  'use strict';
  var CA = window.CursorApp;

  CA.renderInputState = function () {
    var socketConnected = CursorSocket.isConnected();
    var extensionConnected = CA.state.connected;
    var isLooped = CA.isWindowLooped();
    var canSend = socketConnected && (extensionConnected || isLooped);
    var s = CA.state.agentStatus || 'idle';
    var showStop = (s === 'generating' || s === 'streaming' || s === 'thinking' || s === 'running_tool');

    var $btnSend = document.getElementById('btn-send');
    var $btnStop = document.getElementById('btn-stop');
    var $input = document.getElementById('message-input');

    if (showStop) {
      $btnStop.classList.remove('hidden');
      $btnSend.classList.add('hidden');
    } else {
      $btnStop.classList.add('hidden');
      $btnSend.classList.remove('hidden');
    }

    var hasContent = !!$input.value.trim() || CA.pendingImages.length > 0;
    $btnSend.disabled = !hasContent || !canSend;
  };

  CA.sendMessage = function () {
    var $input = document.getElementById('message-input');
    var text = $input.value.trim();
    if (!text && CA.pendingImages.length === 0) return;
    var payload = { text: text };
    var images = null;
    if (CA.pendingImages.length > 0) {
      payload.images = CA.pendingImages.slice();
      images = payload.images;
      CA.pendingImages = [];
      CA.renderImagePreview();
    }
    var isLooped = CA.isWindowLooped();
    var msgId = CursorSocket.newCommandId();
    payload.msgId = msgId;

    CA.addOptimisticMessage(msgId, text, images, isLooped ? 'sending_mcp' : 'sending');

    var commandId = CursorSocket.sendCommand('send_message', payload);
    if (!commandId) {
      CA.updateOptimisticStatus(msgId, 'failed');
      CA.showToast('Not connected', 'error');
    } else {
      CA.setOptimisticCommandId(msgId, commandId);
    }

    $input.value = '';
    $input.style.height = 'auto';
    document.getElementById('btn-send').disabled = true;
  };

  CA.handleStop = function () {
    CursorSocket.sendCommand('stop');
    CA.showToast('Stop sent', 'success');
  };

  CA.handleImagePaste = function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') === 0) {
        e.preventDefault();
        var file = items[i].getAsFile();
        if (file) addImageFile(file);
        return;
      }
    }
  };

  CA.handleImageFilePick = function () {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.addEventListener('change', function () {
      if (!input.files) return;
      for (var i = 0; i < input.files.length; i++) addImageFile(input.files[i]);
    });
    input.click();
  };

  function addImageFile(file) {
    if (CA.pendingImages.length >= 5) { CA.showToast('Max 5 images', 'error'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      CA.pendingImages.push(reader.result);
      CA.renderImagePreview();
    };
    reader.readAsDataURL(file);
  }

  CA.renderImagePreview = function () {
    var strip = document.getElementById('image-preview-strip');
    if (!strip) return;
    strip.innerHTML = '';
    if (CA.pendingImages.length === 0) { strip.classList.add('hidden'); return; }
    strip.classList.remove('hidden');
    CA.pendingImages.forEach(function (dataUrl, idx) {
      var thumb = document.createElement('div');
      thumb.className = 'relative shrink-0';
      var img = document.createElement('img');
      img.src = dataUrl;
      img.className = 'h-12 rounded-md';
      thumb.appendChild(img);
      var removeBtn = document.createElement('button');
      removeBtn.className = 'absolute -top-1 -right-1 w-4 h-4 rounded-full bg-destructive text-white text-[10px] flex items-center justify-center';
      removeBtn.textContent = '\u2715';
      removeBtn.addEventListener('click', function () {
        CA.pendingImages.splice(idx, 1);
        CA.renderImagePreview();
      });
      thumb.appendChild(removeBtn);
      strip.appendChild(thumb);
    });
  };
})();
