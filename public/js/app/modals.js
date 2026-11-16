    // ============ 弹窗控制 ============

    function closeModal(id) {
      document.getElementById(id).classList.remove('active');
      if (id === 'telecomLoginOverlay') stopTelecomLogin(true);
      if (id === 'modalOverlay' && _usageCharts[_detailIndex]) {
        _usageCharts[_detailIndex].dispose();
        delete _usageCharts[_detailIndex];
      }
      if (id === 'relayChartOverlay') relayChartOnClose();
      if (id === 'batchIpOverlay') stopBatchIpPoll();
      if (id === 'mgmtOverlay') exitMgmtIpSelect(false);   // 复位批量 IP 勾选模式标志(弹层已关,无需重渲染)
    }
    // 点击遮罩关闭:仅卡片详情(modalOverlay,纯浏览随时可关)保留;
    // 其余弹层含表单/登录态,误触遮罩关闭易丢输入,只能 × 或 Esc 关闭
    document.getElementById('modalOverlay').addEventListener('click', function(e){ if(e.target===e.currentTarget) closeModal('modalOverlay'); });
    document.addEventListener('keydown', function(e){ if(e.key==='Escape') ['pwdOverlay','modalOverlay','mgmtOverlay','telecomLoginOverlay','weightOverlay','schedulerOverlay','relayChartOverlay','batchIpOverlay'].forEach(closeModal); });

