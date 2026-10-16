export function classifyDelivery(order, currentInstant) {
  if (order.status === 'Delivered') {
    return 'Delivered'
  }

  const expectedDelivery = order.inspectionAt

  if (
    expectedDelivery == null
    || (typeof expectedDelivery === 'string' && expectedDelivery.trim() === '')
  ) {
    return 'Unknown'
  }

  const expectedDeliveryTime = new Date(expectedDelivery).getTime()

  if (Number.isNaN(expectedDeliveryTime)) {
    const error = new TypeError('Invalid expected delivery timestamp')
    error.orderId = order.id
    throw error
  }

  const currentTime = new Date(currentInstant).getTime()

  if (Number.isNaN(currentTime)) {
    throw new TypeError('Invalid current instant')
  }

  return expectedDeliveryTime < currentTime ? 'Late' : 'On track'
}
