    // ============ 弹窗控制 ============

    function closeModal(id) {
      document.getElementById(id).classList.remove('active');
      if (id === 'telecomLoginOverlay') stopTelecomLogin(true);
      if (id === 'modalOverlay' && _usageCharts[_detailIndex]) {
        _usageCharts[_detailIndex].dispose();
        delete _usageCharts[_detailIndex];
      }
    }
    ['pwdOverlay','modalOverlay','mgmtOverlay','telecomLoginOverlay','weightOverlay'].forEach(function(id){
      document.getElementById(id).addEventListener('click', function(e){ if(e.target===e.currentTarget) closeModal(id); });
    });
    document.addEventListener('keydown', function(e){ if(e.key==='Escape') ['pwdOverlay','modalOverlay','mgmtOverlay','telecomLoginOverlay','weightOverlay'].forEach(closeModal); });

