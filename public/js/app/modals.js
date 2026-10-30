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
    ['pwdOverlay','modalOverlay','mgmtOverlay','telecomLoginOverlay','weightOverlay','relayChartOverlay','batchIpOverlay'].forEach(function(id){
      document.getElementById(id).addEventListener('click', function(e){ if(e.target===e.currentTarget) closeModal(id); });
    });
    document.addEventListener('keydown', function(e){ if(e.key==='Escape') ['pwdOverlay','modalOverlay','mgmtOverlay','telecomLoginOverlay','weightOverlay','relayChartOverlay','batchIpOverlay'].forEach(closeModal); });

